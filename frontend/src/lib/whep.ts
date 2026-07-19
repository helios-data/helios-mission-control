// Minimal WHEP client (WebRTC-HTTP Egress Protocol) for the go2rtc Video node.
//
// go2rtc restreams the USB-capture VTX feed as WebRTC. The overlay POSTs an SDP
// offer to the WHEP endpoint (config `ui.video_url`, e.g.
// http://<host>:1984/api/whep?src=cloudburst) and plays the returned answer.
// LAN-only, so no STUN/TURN is required (works fully offline at the launch site).

export interface WhepSession {
  close: () => void;
}

export async function playWhep(
  url: string,
  video: HTMLVideoElement,
  onState?: (state: RTCPeerConnectionState) => void,
): Promise<WhepSession> {
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  pc.ontrack = (ev) => {
    if (ev.streams[0] && video.srcObject !== ev.streams[0]) {
      video.srcObject = ev.streams[0];
    }
  };
  pc.onconnectionstatechange = () => onState?.(pc.connectionState);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc, 2000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription!.sdp,
    });
  } catch (e) {
    pc.close();
    throw new Error(`WHEP request failed: ${String(e)}`);
  }
  if (!res.ok) {
    pc.close();
    throw new Error(`WHEP endpoint returned ${res.status}`);
  }

  const answer = await res.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });

  return {
    close: () => {
      const s = video.srcObject as MediaStream | null;
      s?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      pc.close();
    },
  };
}

// go2rtc answers non-trickle, so gather all local candidates before POSTing
// (bounded by a timeout in case gathering stalls).
function waitIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}
