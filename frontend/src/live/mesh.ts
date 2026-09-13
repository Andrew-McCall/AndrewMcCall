// The connections. Everyone holds one RTCPeerConnection per other person, so a
// room of six is fifteen connections and five copies of everything you send —
// which is why the room is capped at six.
//
// Every connection carries the same four transceivers in the same order, and
// they are created once and never renegotiated: switching a camera on is
// replaceTrack on a sender that already exists. Renegotiating in a mesh is
// where these things usually break, and this design never does it.

import type { PeerSummary } from "@andrewmccall/api-types";
import { sendSignal, type Signal } from "./api";
import {
  adoptTransceivers,
  MIDS,
  sourceOfMid,
  weOffer,
  withStereoAppAudio,
  type SourceName,
} from "./negotiation";

export type Tracks = Record<SourceName, MediaStreamTrack | null>;

export const noTracks = (): Tracks => ({
  mic: null,
  app: null,
  camera: null,
  screen: null,
});

export interface MeshHandlers {
  // A track arrived from someone. Which source it is comes from its mid.
  track: (peerId: string, source: SourceName, track: MediaStreamTrack) => void;
  // Connection state changed, with the candidate path once there is one.
  state: (peerId: string, state: RTCPeerConnectionState, path: string) => void;
}

interface Connection {
  pc: RTCPeerConnection;
  // One per source, indexed the same way MIDS is.
  senders: RTCRtpSender[];
  // Candidates that arrived before the remote description they belong to.
  // Adding one early throws, and dropping them costs connections on the exact
  // networks that need every candidate they can get.
  early: RTCIceCandidateInit[];
}

export function createMesh(
  roomId: string,
  self: string,
  ourSeq: number,
  iceServers: RTCIceServer[],
  handlers: MeshHandlers,
) {
  const connections = new Map<string, Connection>();
  let local = noTracks();

  const send = (to: string, kind: Signal["kind"], payload: unknown) =>
    sendSignal(roomId, { from: self, to, kind, payload }).catch(() => {
      // A failed signal is a connection that will not come up; the state
      // handler reports it, and there is nothing useful to retry here.
    });

  const attach = (connection: Connection) => {
    MIDS.forEach((source, index) => {
      void connection.senders[index]?.replaceTrack(local[source]);
    });
  };

  const open = (peerId: string, offering: boolean): Connection => {
    const pc = new RTCPeerConnection({ iceServers });
    const connection: Connection = { pc, senders: [], early: [] };
    connections.set(peerId, connection);

    if (offering) {
      // The layout, created in the order the mids are read back in.
      connection.senders = [
        pc.addTransceiver("audio", { direction: "sendrecv" }),
        pc.addTransceiver("audio", { direction: "sendrecv" }),
        pc.addTransceiver("video", { direction: "sendrecv" }),
        pc.addTransceiver("video", { direction: "sendrecv" }),
      ].map((transceiver) => transceiver.sender);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) void send(peerId, "ice", event.candidate.toJSON());
    };

    pc.ontrack = (event) => {
      const source = sourceOfMid(event.transceiver.mid);
      if (source) handlers.track(peerId, source, event.track);
    };

    pc.onconnectionstatechange = () => {
      void describe(peerId, connection);
    };

    return connection;
  };

  const describe = async (peerId: string, connection: Connection) => {
    handlers.state(peerId, connection.pc.connectionState, await path(connection.pc));
  };

  // Adopts the transceivers an offer created: mid order, and each switched to
  // sendrecv so this end can actually send on them. Done before createAnswer,
  // so the answer advertises them as sendrecv and nothing needs renegotiating.
  const adopt = (connection: Connection) => {
    connection.senders = adoptTransceivers(connection.pc.getTransceivers()).map(
      (transceiver) => transceiver.sender,
    );
  };

  const drain = async (connection: Connection) => {
    for (const candidate of connection.early.splice(0)) {
      await connection.pc.addIceCandidate(candidate).catch(() => {});
    }
  };

  return {
    // Someone is here. Whoever joined first offers.
    async add(peer: PeerSummary) {
      if (connections.has(peer.peer_id)) return;
      if (!weOffer(ourSeq, peer.seq)) return; // they will offer to us

      const connection = open(peer.peer_id, true);
      attach(connection);

      const offer = await connection.pc.createOffer();
      if (offer.sdp) offer.sdp = withStereoAppAudio(offer.sdp);
      await connection.pc.setLocalDescription(offer);
      void send(peer.peer_id, "offer", connection.pc.localDescription);
    },

    async signal(message: Signal) {
      const from = message.from;

      if (message.kind === "offer") {
        const connection = connections.get(from) ?? open(from, false);
        await connection.pc.setRemoteDescription(
          message.payload as RTCSessionDescriptionInit,
        );
        adopt(connection);
        attach(connection);

        const answer = await connection.pc.createAnswer();
        if (answer.sdp) answer.sdp = withStereoAppAudio(answer.sdp);
        await connection.pc.setLocalDescription(answer);
        await drain(connection);
        void send(from, "answer", connection.pc.localDescription);
        return;
      }

      const connection = connections.get(from);
      if (!connection) return;

      if (message.kind === "answer") {
        await connection.pc.setRemoteDescription(
          message.payload as RTCSessionDescriptionInit,
        );
        await drain(connection);
        return;
      }

      const candidate = message.payload as RTCIceCandidateInit;
      if (connection.pc.remoteDescription) {
        await connection.pc.addIceCandidate(candidate).catch(() => {});
      } else {
        connection.early.push(candidate);
      }
    },

    remove(peerId: string) {
      connections.get(peerId)?.pc.close();
      connections.delete(peerId);
    },

    // Publishes a new set of local tracks to everyone at once. No
    // renegotiation: the senders already exist on every connection.
    setTracks(tracks: Tracks) {
      local = tracks;
      connections.forEach(attach);
    },

    close() {
      connections.forEach((connection) => connection.pc.close());
      connections.clear();
    },
  };
}

// The candidate pair actually carrying media, as "host → srflx". Without this
// there is no way to tell a direct connection from a relayed one, and "it
// didn't connect" stays unfalsifiable.
async function path(pc: RTCPeerConnection): Promise<string> {
  try {
    const stats = await pc.getStats();
    let pair: any = null;
    stats.forEach((report: any) => {
      if (report.type === "candidate-pair" && report.state === "succeeded") {
        pair = report;
      }
    });
    if (!pair) return "";

    const local: any = stats.get(pair.localCandidateId);
    const remote: any = stats.get(pair.remoteCandidateId);
    return `${local?.candidateType ?? "?"} → ${remote?.candidateType ?? "?"}`;
  } catch {
    return "";
  }
}
