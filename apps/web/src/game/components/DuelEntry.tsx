import { useState } from "react";

import type {
  DuelConnectionStatus,
  EnterRoomInput
} from "../duel/duelTypes.ts";

export interface DuelEntryProps {
  readonly connection: DuelConnectionStatus;
  readonly initialRoomCode: string;
  readonly error: string | null;
  readonly onCreate: (input: EnterRoomInput) => Promise<void>;
  readonly onJoin: (input: EnterRoomInput) => Promise<void>;
}

export function DuelEntry({
  connection,
  initialRoomCode,
  error,
  onCreate,
  onJoin
}: DuelEntryProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState("");
  const [roomCode, setRoomCode] = useState(initialRoomCode);
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = connection === "connecting";

  const run = async (mode: "create" | "join") => {
    setLocalError(null);
    try {
      const input = { displayName, roomCode };
      if (mode === "create") await onCreate(input);
      else await onJoin(input);
    } catch (caught) {
      setLocalError(
        caught instanceof Error ? caught.message : "无法进入房间。"
      );
    }
  };

  return (
    <main className="duel-entry">
      <section className="duel-entry__intro">
        <span>2P / AUTHORITATIVE DUEL</span>
        <h1>双人对战</h1>
        <p>
          两边共享完全相同的 7-Bag；操作先在本机显示，再异步送往
          240Hz 权威比赛服务器。
        </p>
      </section>
      <section className="duel-entry__panel">
        <label>
          <span>昵称</span>
          <input
            autoComplete="nickname"
            maxLength={24}
            name="displayName"
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="PLAYER"
            value={displayName}
          />
        </label>
        <label>
          <span>房间码</span>
          <input
            autoCapitalize="characters"
            maxLength={8}
            name="roomCode"
            onChange={(event) =>
              setRoomCode(event.target.value.toUpperCase())
            }
            placeholder="例如 AB3K7Q"
            value={roomCode}
          />
        </label>
        <div className="duel-entry__actions">
          <button
            className="button button--primary"
            data-action="join"
            disabled={busy || roomCode.trim().length === 0}
            onClick={() => void run("join")}
            type="button"
          >
            加入房间
          </button>
          <button
            className="button"
            data-action="create"
            disabled={busy}
            onClick={() => void run("create")}
            type="button"
          >
            创建新房间
          </button>
        </div>
        {(localError ?? error) !== null && (
          <p className="duel-error" role="alert">{localError ?? error}</p>
        )}
        {busy && <p className="duel-connecting" role="status">正在连接…</p>}
      </section>
    </main>
  );
}
