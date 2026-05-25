export interface SessionResponse {
  docId: string;
  snapshotUrl: string | null;
  snapshotSeqNum: number;
  limits: {
    maxRecordBytes: number;
    maxOpsPerSec: number;
  };
}

export interface AppendResponse {
  startSeqNum: number;
  endSeqNum: number;
  nextSeqNum: number;
}

export interface ReadResponse {
  records: ReadRecordResponse[];
  nextSeqNum: number;
  reset?: boolean;
}

export interface ReadRecordResponse {
  seqNum: number;
  body: string;
}
