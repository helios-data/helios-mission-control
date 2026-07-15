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

    // Full 3D attitude: integrate gyro rates + gravity-correct near 1 g.
    if (!srad || state === "STANDBY") {
      q.current.slerp(tmp.current.identity(), Math.min(1, dt * 2));
      g.quaternion.copy(q.current);
      if (!srad) return;
    }
    const toRad = gyroUnits === "deg" ? Math.PI / 180 : 1;
    const wq = tmp.current.set(
      (srad!.gyro.x ?? 0) * toRad * dt * 0.5,
      (srad!.gyro.y ?? 0) * toRad * dt * 0.5,
      (srad!.gyro.z ?? 0) * toRad * dt * 0.5,
      1,
    ).normalize();
    q.current.multiply(wq).normalize();
    const ax = srad!.accel.x ?? 0, ay = srad!.accel.y ?? 1, az = srad!.accel.z ?? 0;
    const amag = Math.hypot(ax, ay, az);
    if (amag > 0.7 && amag < 1.3) {
      const measuredUp = new THREE.Vector3(ax, ay, az).normalize();
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
