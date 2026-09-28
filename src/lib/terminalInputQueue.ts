const INPUT_BUDGET_BYTES = 256 * 1024;
const INPUT_CHUNK_BYTES = 16 * 1024;

type PendingInput = {
  bytes: Uint8Array;
  offset: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

export function createTerminalInputQueue(
  sessionId: string,
  sendData: (id: string, bytes: Uint8Array) => Promise<void>,
  sendResize: (id: string, cols: number, rows: number) => Promise<void>,
  onError: (error: Error) => void,
) {
  let pending: PendingInput[] = [];
  let pendingBytes = 0;
  let closed = false;
  let sending = false;
  let resizing = false;
  let latestSize: [number, number] | null = null;

  function stop(error: Error) {
    closed = true;
    latestSize = null;
    const rejected = pending;
    pending = [];
    pendingBytes = 0;
    for (const item of rejected) item.reject(error);
  }

  function fail(reason: unknown) {
    if (closed) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    stop(error);
    onError(error);
  }

  async function drain() {
    sending = true;
    try {
      while (!closed && pending.length > 0) {
        const item = pending[0];
        const end = Math.min(item.offset + INPUT_CHUNK_BYTES, item.bytes.length);
        const bytes = item.bytes.subarray(item.offset, end);
        await sendData(sessionId, bytes);
        if (closed) return;
        pendingBytes -= bytes.length;
        item.offset = end;
        if (end === item.bytes.length) {
          pending.shift();
          item.resolve();
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      sending = false;
    }
  }

  async function drainResize() {
    resizing = true;
    try {
      while (!closed && latestSize) {
        const [cols, rows] = latestSize;
        latestSize = null;
        await sendResize(sessionId, cols, rows);
      }
    } catch (error) {
      fail(error);
    } finally {
      resizing = false;
    }
  }

  return {
    enqueue(bytes: Uint8Array): Promise<void> {
      if (closed) return Promise.reject(new Error("终端输入队列已关闭"));
      if (bytes.length === 0) return Promise.resolve();
      // Admission is synchronous and atomic for the whole event, before copying or sending.
      if (pendingBytes + bytes.length > INPUT_BUDGET_BYTES) {
        const error = new Error("输入队列已满，请等待已接受的输入发送完成后分段粘贴");
        onError(error);
        return Promise.reject(error);
      }
      pendingBytes += bytes.length;
      const completion = new Promise<void>((resolve, reject) => {
        pending.push({ bytes: bytes.slice(), offset: 0, resolve, reject });
      });
      if (!sending) void drain();
      return completion;
    },
    resize(cols: number, rows: number) {
      if (closed) return;
      latestSize = [cols, rows];
      if (!resizing) void drainResize();
    },
    close() { stop(new Error("终端输入队列已关闭")); },
  };
}
