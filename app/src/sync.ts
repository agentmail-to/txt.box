import * as Y from "yjs";
import type { SessionResponse } from "../../shared/types";
import { FLUSH_DEBOUNCE_MS, MAX_DOC_BYTES } from "../../shared/constants";
import { appendUpdate, readUpdates } from "./api";

export interface SyncState {
  doc: Y.Doc;
  text: Y.Text;
  destroy: () => void;
}

export async function startSync(
  session: SessionResponse,
  textarea: HTMLTextAreaElement,
  onStatus: (status: string) => void,
  onTextChange: (text: string) => void,
  initialText?: string
): Promise<SyncState> {
  const doc = new Y.Doc();
  const text = doc.getText("content");

  if (session.snapshotUrl) {
    const res = await fetch(session.snapshotUrl);
    if (res.ok) {
      const buf = await res.arrayBuffer();
      Y.applyUpdate(doc, new Uint8Array(buf), "remote");
    } else {
      throw new Error(`snapshot fetch failed: ${res.status}`);
    }
  }

  let suppressLocal = false;
  let docTooLarge = false;
  let destroyed = false;
  let appendInFlight = false;
  let flushTimer: number | null = null;
  let pendingUpdates: Uint8Array[] = [];

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote" || docTooLarge) return;
    pendingUpdates.push(update);
    onStatus("Saving...");
    scheduleFlush();
  });

  text.observe(() => {
    const newVal = text.toString();
    onTextChange(newVal);
    checkDocSize();
    if (suppressLocal) return;
    const { selectionStart, selectionEnd } = textarea;
    textarea.value = newVal;
    textarea.selectionStart = selectionStart;
    textarea.selectionEnd = selectionEnd;
  });

  textarea.addEventListener("input", () => {
    const newVal = textarea.value;
    const oldVal = text.toString();
    if (newVal === oldVal) return;

    suppressLocal = true;
    doc.transact(() => {
      applyDiff(text, oldVal, newVal);
    });
    suppressLocal = false;
  });

  if (initialText && text.length === 0) {
    doc.transact(() => {
      text.insert(0, initialText);
    });
  }

  textarea.value = text.toString();
  textarea.scrollTop = 0;
  textarea.selectionStart = textarea.selectionEnd = 0;
  onTextChange(text.toString());

  let tailActive = true;
  let readAbortController: AbortController | null = null;
  let nextReadSeqNum = session.snapshotSeqNum;

  const startTail = async () => {
    while (tailActive) {
      try {
        readAbortController = new AbortController();
        const batch = await readUpdates(
          session.docId,
          nextReadSeqNum,
          readAbortController.signal,
        );
        readAbortController = null;

        if (batch.reset) {
          console.warn("read position trimmed, restarting from stream tail");
          const previousSeqNum = nextReadSeqNum;
          nextReadSeqNum = batch.nextSeqNum;
          if (nextReadSeqNum === previousSeqNum) {
            await new Promise((r) => setTimeout(r, 2000));
          }
          continue;
        }

        for (const rec of batch.records) {
          if (!tailActive) break;
          nextReadSeqNum = rec.seqNum + 1;
          applyRecord(doc, base64ToBytes(rec.body));
        }

        if (batch.nextSeqNum > nextReadSeqNum) {
          nextReadSeqNum = batch.nextSeqNum;
        }
      } catch (e) {
        readAbortController = null;
        if (!tailActive) break;
        console.error("read session error, retrying:", e);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  startTail();

  function checkDocSize() {
    const size = new TextEncoder().encode(text.toString()).byteLength;
    if (size > MAX_DOC_BYTES && !docTooLarge) {
      docTooLarge = true;
      onStatus("Doc too large");
      textarea.setAttribute("readonly", "");
    } else if (size <= MAX_DOC_BYTES && docTooLarge) {
      docTooLarge = false;
      textarea.removeAttribute("readonly");
    }
  }

  return {
    doc,
    text,
    destroy() {
      destroyed = true;
      tailActive = false;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      readAbortController?.abort();
      doc.destroy();
    },
  };

  function scheduleFlush(delay = FLUSH_DEBOUNCE_MS) {
    if (destroyed || flushTimer !== null) return;
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      void flushUpdates();
    }, delay);
  }

  async function flushUpdates() {
    if (destroyed || appendInFlight) return;
    if (pendingUpdates.length === 0) {
      onStatus("Saved");
      return;
    }

    const updates = pendingUpdates;
    pendingUpdates = [];
    appendInFlight = true;

    try {
      const merged =
        updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
      await appendUpdate(session.docId, merged);
    } catch {
      pendingUpdates = [...updates, ...pendingUpdates];
      onStatus("Offline");
      scheduleFlush(2000);
      return;
    } finally {
      appendInFlight = false;
    }

    if (pendingUpdates.length > 0) {
      scheduleFlush();
    } else {
      onStatus("Saved");
    }
  }
}

function applyRecord(doc: Y.Doc, body: Uint8Array) {
  if (!body || body.length === 0) return;
  // Legacy: skip old JSON snapshot markers still in the stream
  try {
    JSON.parse(new TextDecoder().decode(body));
    return;
  } catch {
    // binary Yjs update
  }
  Y.applyUpdate(doc, body, "remote");
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function applyDiff(ytext: Y.Text, oldVal: string, newVal: string) {
  let start = 0;
  const minLen = Math.min(oldVal.length, newVal.length);
  while (start < minLen && oldVal[start] === newVal[start]) start++;

  let oldEnd = oldVal.length;
  let newEnd = newVal.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldVal[oldEnd - 1] === newVal[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  const deleteCount = oldEnd - start;
  const insertText = newVal.slice(start, newEnd);

  if (deleteCount > 0) ytext.delete(start, deleteCount);
  if (insertText) ytext.insert(start, insertText);
}
