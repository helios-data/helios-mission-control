import { Canvas, useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import type { MissionStore } from "../lib/store";

// Procedural CloudBurst stand-in: body tube + nosecone + 3 fins. Swap in a glTF
// of the real airframe when provided (Open Question 9).
function RocketModel() {
  return (
    <group>
      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[0.35, 0.35, 2.4, 32]} />
        <meshStandardMaterial color="#c9d3e0" metalness={0.3} roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.75, 0]}>
        <coneGeometry args={[0.35, 1.0, 32]} />
        <meshStandardMaterial color="#f0b323" metalness={0.2} roughness={0.4} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[0, -0.9, 0]} rotation={[0, (i * 2 * Math.PI) / 3, 0]}>
          <boxGeometry args={[0.02, 0.7, 0.6]} />
          <meshStandardMaterial color="#4aa3ff" />
        </mesh>
      ))}
      {/* nozzle */}
      <mesh position={[0, -1.15, 0]}>
        <cylinderGeometry args={[0.2, 0.28, 0.25, 24]} />
        <meshStandardMaterial color="#3a4150" />
      </mesh>
    </group>
  );
}

function AttitudeRig({
  store, gyroUnits,
}: {
  store: MissionStore;
  gyroUnits: "deg" | "rad";
}) {
  const ref = useRef<THREE.Group>(null);
  const q = useRef(new THREE.Quaternion());
  const tmp = useRef(new THREE.Quaternion());

  useFrame((_s, dt) => {
    const g = ref.current;
    if (!g) return;
    const srad = store.srad;
    const state = srad?.flight_state ?? "STANDBY";

    // "Up" (nose) is the direction opposite gravity. Body IMU is Z-up (nose = +Z);
    // Three.js render frame is Y-up. Remap accel body -> render
    // ((x, y, z)_body -> (x, z, -y)_render) and negate to get up = -gravity. Accel
    // is in m/s^2 (~9.81 at 1 g). At rest upright this is ~(0, +1, 0)_render.
    const upRender = new THREE.Vector3(
      -(srad?.accel.x ?? 0),
      -(srad?.accel.z ?? 0),
      srad?.accel.y ?? 0,
    );

    // Not armed/in flight yet (or no data): calibrate attitude straight from the
    // gravity vector. Pure orientation, no integration -> no drift on the bench,
    // and the model tilts with the airframe as you move it.
    if (!srad || state === "STANDBY") {
      if (srad && upRender.lengthSq() > 1e-6) {
        const target = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0), upRender.normalize(),
        );
        q.current.slerp(target, Math.min(1, dt * 4));
      } else {
        q.current.slerp(tmp.current.identity(), Math.min(1, dt * 2));
      }
      g.quaternion.copy(q.current);
      return;
    }

    // In flight: integrate gyro rates, then gravity-correct tilt when accel is
    // near 1 g (not maneuvering hard). Remap gyro body -> render too.
    const toRad = gyroUnits === "deg" ? Math.PI / 180 : 1;
    const gx = srad.gyro.x ?? 0, gy = srad.gyro.y ?? 0, gz = srad.gyro.z ?? 0;
    const wq = tmp.current.set(
      gx * toRad * dt * 0.5,   // render X
      gz * toRad * dt * 0.5,   // roll about nose -> render Y
      -gy * toRad * dt * 0.5,  // render Z
      1,
    ).normalize();
    q.current.multiply(wq).normalize();
    // Accel is m/s^2 -> compare in g. Only trust it as "up" near 1 g.
    const gRatio = upRender.length() / 9.81;
    if (gRatio > 0.7 && gRatio < 1.3) {
      const measuredUp = upRender.normalize();   // already = -gravity (up)
      const worldUpInBody = new THREE.Vector3(0, 1, 0).applyQuaternion(q.current.clone().invert());
      const corr = new THREE.Quaternion().setFromUnitVectors(worldUpInBody, measuredUp);
      q.current.multiply(new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), corr, 0.02));
      q.current.normalize();
    }
    g.quaternion.copy(q.current);
  });

  return (
    <group ref={ref}>
      <RocketModel />
    </group>
  );
}

export function Rocket3D({
  store, gyroUnits = "deg", height = 300, hasData,
}: {
  store: MissionStore;
  gyroUnits?: "deg" | "rad";
  height?: number;
  hasData: boolean;
}) {
  return (
    <div style={{ width: "100%", height, position: "relative" }}>
      <Canvas camera={{ position: [0, 0.4, 6.5], fov: 34 }} dpr={[1, 2]}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 8, 5]} intensity={1.1} />
        <directionalLight position={[-4, 2, -3]} intensity={0.4} color="#5ad1ff" />
        <group scale={hasData ? 1 : 0.9}>
          <AttitudeRig store={store} gyroUnits={gyroUnits} />
        </group>
      </Canvas>
      {!hasData && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center",
          justifyContent: "center", pointerEvents: "none",
        }}>
          <span className="empty-note upper">No attitude data</span>
        </div>
      )}
    </div>
  );
}
