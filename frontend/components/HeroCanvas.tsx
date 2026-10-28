"use client";

import { useEffect, useRef } from "react";

/**
 * Hero background: a slowly rotating wireframe core wrapped in a shell of
 * particles and two orbiting rings, with light pointer parallax.
 *
 * three.js is imported lazily inside the effect so nothing touches WebGL (or
 * the DOM) during SSR/prerender.
 */
export default function HeroCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let frame = 0;
    let cleanup: (() => void) | undefined;

    (async () => {
      const THREE = await import("three");
      if (disposed || !hostRef.current) return;

      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.set(0, 0, 5.4);

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        });
      } catch {
        return; // no WebGL — the CSS glows still carry the hero
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      host.appendChild(renderer.domElement);

      const group = new THREE.Group();
      scene.add(group);

      // --- wireframe core -------------------------------------------------
      const coreGeo = new THREE.IcosahedronGeometry(1.4, 1);
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0x25d366,
        wireframe: true,
        transparent: true,
        opacity: 0.34,
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      group.add(core);

      // --- inner solid for depth -----------------------------------------
      const innerGeo = new THREE.IcosahedronGeometry(1.36, 2);
      const innerMat = new THREE.MeshBasicMaterial({
        color: 0x0a1410,
        transparent: true,
        opacity: 0.85,
      });
      const inner = new THREE.Mesh(innerGeo, innerMat);
      group.add(inner);

      // --- particle shell -------------------------------------------------
      const COUNT = 1400;
      const positions = new Float32Array(COUNT * 3);
      for (let i = 0; i < COUNT; i++) {
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        const r = 2.35 + (Math.random() - 0.5) * 0.5;
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
      }
      const shellGeo = new THREE.BufferGeometry();
      shellGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const shellMat = new THREE.PointsMaterial({
        color: 0x9ff9c8,
        size: 0.032,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      });
      const shell = new THREE.Points(shellGeo, shellMat);
      group.add(shell);

      // --- orbit rings ----------------------------------------------------
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x7c8cff,
        transparent: true,
        opacity: 0.45,
      });
      const ringGeo = new THREE.TorusGeometry(2.62, 0.005, 8, 240);
      const ringA = new THREE.Mesh(ringGeo, ringMat);
      ringA.rotation.set(Math.PI / 2.35, 0.2, 0);
      const ringB = new THREE.Mesh(ringGeo, ringMat);
      ringB.rotation.set(Math.PI / 1.7, -0.55, 0.4);
      group.add(ringA, ringB);

      // --- sizing ---------------------------------------------------------
      const resize = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(host);

      // --- pointer parallax ----------------------------------------------
      const pointer = { x: 0, y: 0 };
      const target = { x: 0, y: 0 };
      const onPointer = (e: PointerEvent) => {
        target.x = (e.clientX / window.innerWidth - 0.5) * 0.5;
        target.y = (e.clientY / window.innerHeight - 0.5) * 0.5;
      };
      if (!reduced) window.addEventListener("pointermove", onPointer, {
        passive: true,
      });

      // --- loop -----------------------------------------------------------
      const clock = new THREE.Clock();
      const tick = () => {
        const t = clock.getElapsedTime();
        pointer.x += (target.x - pointer.x) * 0.05;
        pointer.y += (target.y - pointer.y) * 0.05;

        group.rotation.y = t * 0.14 + pointer.x;
        group.rotation.x = Math.sin(t * 0.32) * 0.12 + pointer.y;
        shell.rotation.y = -t * 0.1;
        shell.rotation.z = t * 0.05;
        ringA.rotation.z = t * 0.24;
        ringB.rotation.z = -t * 0.19;

        const pulse = 1 + Math.sin(t * 1.1) * 0.022;
        core.scale.setScalar(pulse);
        inner.scale.setScalar(pulse);

        renderer.render(scene, camera);
        frame = requestAnimationFrame(tick);
      };

      if (reduced) renderer.render(scene, camera);
      else frame = requestAnimationFrame(tick);

      cleanup = () => {
        cancelAnimationFrame(frame);
        ro.disconnect();
        window.removeEventListener("pointermove", onPointer);
        coreGeo.dispose();
        coreMat.dispose();
        innerGeo.dispose();
        innerMat.dispose();
        shellGeo.dispose();
        shellMat.dispose();
        ringGeo.dispose();
        ringMat.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return <div className="scene" ref={hostRef} aria-hidden="true" />;
}
