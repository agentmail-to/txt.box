import type {
  AppendResponse,
  ReadResponse,
  SessionResponse,
} from "../../shared/types";

const API_BASE =
  import.meta.env.VITE_API_BASE ?? "https://api.txt.box";

export async function createSession(docId: string): Promise<SessionResponse> {
  const res = await fetch(`${API_BASE}/session?doc=${encodeURIComponent(docId)}`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`session failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function appendUpdate(
  docId: string,
  update: Uint8Array,
): Promise<AppendResponse> {
  const body = new Uint8Array(update).buffer;
  const res = await fetch(`${API_BASE}/append?doc=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`append failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function readUpdates(
  docId: string,
  seqNum: number,
  signal?: AbortSignal,
): Promise<ReadResponse> {
  const params = new URLSearchParams({
    doc: docId,
    seq: String(seqNum),
  });
  const res = await fetch(`${API_BASE}/read?${params}`, { signal });
  if (!res.ok) {
    throw new Error(`read failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
