import { useEffect, useRef, useState, type FormEvent } from "react";
import { Heart, Mic, Sparkles } from "lucide-react";
import {
  castVote,
  joinSeat,
  leaveSeat,
  nextNever,
  removeSeat,
  resetTable,
  setTimer,
  startGame,
  syncSeat,
} from "@/lib/nhie.functions";
import type { RoomView, SeatResult, Vote } from "@/lib/nhie-types";

const STORAGE_KEY = "nhie.seat.v1";

type Session = { id: string; token: string; name: string };

const RULES = [
  {
    icon: Mic,
    title: "Say it out loud",
    body: "Someone speaks the never. Nothing on this page gets typed.",
  },
  {
    icon: Heart,
    title: "Ten hearts",
    body: "Green means you never have. Red means you have, and it costs a heart.",
  },
  {
    icon: Sparkles,
    title: "Out isn't silent",
    body: "At zero hearts you stay aboard and can still say the next never.",
  },
];

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.id || !parsed.token || !parsed.name) return null;
    return { id: parsed.id, token: parsed.token, name: parsed.name };
  } catch {
    return null;
  }
}

function saveSession(session: Session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function newSession(name: string): Session {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id: crypto.randomUUID(), token, name };
}

async function callSeat(run: () => Promise<SeatResult>): Promise<SeatResult> {
  try {
    return await run();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The table didn't answer.",
    };
  }
}

export function NeverTable() {
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [link, setLink] = useState<"live" | "retry">("live");
  const [banner, setBanner] = useState("");
  const gen = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    const saved = readSession();
    if (!saved) return;
    let stop = false;
    void (async () => {
      const res = await callSeat(() => syncSeat({ data: { id: saved.id, token: saved.token } }));
      if (stop) return;
      if (!res.ok) {
        localStorage.removeItem(STORAGE_KEY);
        setBanner(res.error);
        return;
      }
      setSession(saved);
      setRoom(res.room);
    })();
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    let stop = false;
    let timer = 0;

    async function tick() {
      if (stop) return;
      const ticket = gen.current;
      const current = sessionRef.current;
      if (!current) return;
      try {
        const res = await syncSeat({ data: { id: current.id, token: current.token } });
        if (stop) return;
        if (ticket !== gen.current) {
          timer = window.setTimeout(() => void tick(), 1000);
          return;
        }
        if (res.ok) {
          setRoom(res.room);
          setLink("live");
        } else if (res.error.includes("Sit down")) {
          localStorage.removeItem(STORAGE_KEY);
          setSession(null);
          setRoom(null);
          setBanner(res.error);
          return;
        } else {
          setLink("retry");
        }
      } catch {
        if (!stop && ticket === gen.current) setLink("retry");
      }
      if (!stop) timer = window.setTimeout(() => void tick(), 1000);
    }

    timer = window.setTimeout(() => void tick(), 1000);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [session?.id, session?.token]);

  async function commit(action: () => Promise<SeatResult>) {
    const res = await callSeat(action);
    if (res.ok) {
      gen.current += 1;
      setRoom(res.room);
      setBanner("");
      setLink("live");
    } else {
      setBanner(res.error);
    }
    return res;
  }

  if (!session || !room) {
    return (
      <div className="sky">
        <SkyBits />
        <Door
          initialError={banner}
          onSeated={(next, view) => {
            saveSession(next);
            setSession(next);
            setRoom(view);
            setBanner("");
          }}
        />
      </div>
    );
  }

  return (
    <div className="sky">
      <SkyBits />
      <Table
        room={room}
        link={link}
        banner={banner}
        onVote={(vote) =>
          commit(() => castVote({ data: { id: session.id, token: session.token, vote } }))
        }
        onNext={() => commit(() => nextNever({ data: { id: session.id, token: session.token } }))}
        onTimer={(action) =>
          commit(() => setTimer({ data: { id: session.id, token: session.token, action } }))
        }
        onStart={() => commit(() => startGame({ data: { id: session.id, token: session.token } }))}
        onReset={() => commit(() => resetTable({ data: { id: session.id, token: session.token } }))}
        onRemove={(targetId) =>
          commit(() => removeSeat({ data: { id: session.id, token: session.token, targetId } }))
        }
        onClaim={async (hostKey) => {
          const res = await commit(() =>
            joinSeat({
              data: {
                id: session.id,
                token: session.token,
                name: room.you.name,
                code: "RICK",
                hostKey,
                claimHost: true,
              },
            }),
          );
          return res.ok ? "" : res.error;
        }}
        onLeave={async () => {
          try {
            await leaveSeat({ data: { id: session.id, token: session.token } });
          } catch {
            setBanner("Couldn't leave the table. Try again.");
            return;
          }
          localStorage.removeItem(STORAGE_KEY);
          setSession(null);
          setRoom(null);
          setBanner("");
        }}
      />
    </div>
  );
}

function Door({
  initialError,
  onSeated,
}: {
  initialError: string;
  onSeated: (session: Session, room: RoomView) => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [role, setRole] = useState<"player" | "host">("player");
  const [hostKey, setHostKey] = useState("");
  const [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setError(initialError);
  }, [initialError]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    const session = newSession(name.trim());
    const res = await callSeat(() =>
      joinSeat({
        data: {
          ...session,
          name,
          code,
          hostKey,
          claimHost: role === "host",
        },
      }),
    );
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSeated({ ...session, name: res.room.you.name }, res.room);
  }

  return (
    <main className="relative z-10 mx-auto grid w-full max-w-6xl items-start gap-8 px-6 py-8 lg:min-h-dvh lg:grid-cols-[minmax(0,1.1fr)_minmax(0,26rem)] lg:items-center lg:gap-12 lg:px-10 lg:py-8">
      <section className="min-w-0">
        <p className="caption">Say it out loud. Tap a button.</p>
        <div className="mt-5 flex items-end gap-3">
          <div className="relative h-36 w-28 shrink-0">
            <svg viewBox="0 0 100 100" className="absolute -inset-4 size-40" aria-hidden="true">
              <polygon
                points="50,4 61,36 96,36 68,57 79,92 50,72 21,92 32,57 4,36 39,36"
                fill="#ffe14a"
                stroke="#101428"
                strokeWidth="4"
              />
            </svg>
            <Alien className="relative h-36 w-28" />
          </div>
          <h1 className="door-title">
            Never
            <br />
            have I
            <br />
            ever
          </h1>
        </div>
        <p className="mt-6 max-w-lg text-lg leading-normal text-pretty text-foreground">
          Someone says the Never Have I Ever. Everyone else answers on their own laptop with the green button or the red one.
        </p>
        <div className="vignette mt-6 max-w-lg">
          <PanelScene />
        </div>
        <ul className="mt-10 grid max-w-lg gap-5">
          {RULES.map((rule) => (
            <li key={rule.title} className="flex gap-4">
              <span className="mt-0.5 text-star" aria-hidden="true">
                <rule.icon className="size-5" strokeWidth={2.25} />
              </span>
              <span>
                <span className="block font-medium">{rule.title}</span>
                <span className="mt-1 block text-sm leading-normal text-pretty text-muted">{rule.body}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <form onSubmit={(event) => void submit(event)} className="panel min-w-0 p-6 sm:p-8">
        <h2 className="font-display text-3xl tracking-tight">Come aboard</h2>

        <label className="mt-6 block text-sm font-medium" htmlFor="player-name">
          Your name
        </label>
        <input
          id="player-name"
          className="field mt-2"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="nickname"
          autoFocus
          maxLength={20}
          required
        />

        <label className="mt-5 block text-sm font-medium" htmlFor="table-code">
          Table code
        </label>
        <input
          id="table-code"
          className="field mt-2 uppercase"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          required
        />
        <p className="mt-2 text-sm text-muted">The host will tell you.</p>

        <div className="mt-5" role="radiogroup" aria-label="How you are joining">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["player", "Player"],
                ["host", "Host"],
              ] as const
            ).map(([value, label]) => {
              const selected = role === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={
                    selected
                      ? "press h-11 rounded-xl border-[3px] border-ink bg-paper text-sm font-medium text-paper-foreground"
                      : "press h-11 rounded-xl border-[3px] border-ink bg-background text-sm font-medium text-foreground"
                  }
                  onClick={() => setRole(value)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {role === "host" ? (
          <div className="mt-5">
            <label className="block text-sm font-medium" htmlFor="host-key">
              Host key
            </label>
            <input
              id="host-key"
              className="field mt-2"
              type="password"
              value={hostKey}
              onChange={(event) => setHostKey(event.target.value)}
              autoComplete="off"
              required
            />
            <p className="mt-2 text-sm text-muted">This laptop can start the next never. Still no typing.</p>
          </div>
        ) : null}

        {error ? (
          <p className="mt-5 text-sm text-star" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          className="pop press mt-6 h-12 w-full bg-paper text-base font-medium text-paper-foreground disabled:opacity-50"
          disabled={pending}
        >
          {pending ? "Boarding…" : "Come aboard"}
        </button>
      </form>
    </main>
  );
}

function Hearts({ hearts, size = 16 }: { hearts: number; size?: number }) {
  return (
    <div className="flex items-center gap-2" aria-label={`${hearts} hearts left`}>
      <div className="flex gap-1" aria-hidden="true">
        {Array.from({ length: 10 }, (_, index) => (
          <Heart
            key={index}
            size={size}
            strokeWidth={2.25}
            className={index < hearts ? "fill-done text-done" : "fill-transparent text-muted"}
          />
        ))}
      </div>
      <span className="tabular-nums text-sm font-medium">{hearts}</span>
    </div>
  );
}

function Pips({ hearts }: { hearts: number }) {
  return (
    <span className="flex gap-1" aria-hidden="true">
      {Array.from({ length: 10 }, (_, index) => (
        <span key={index} className={index < hearts ? "pip pip-live" : "pip"} />
      ))}
    </span>
  );
}

function Table({
  room,
  link,
  banner,
  onVote,
  onNext,
  onTimer,
  onStart,
  onReset,
  onRemove,
  onClaim,
  onLeave,
}: {
  room: RoomView;
  link: "live" | "retry";
  banner: string;
  onVote: (vote: Vote) => Promise<SeatResult>;
  onNext: () => Promise<SeatResult>;
  onTimer: (action: "start" | "toggle" | "restart") => Promise<SeatResult>;
  onStart: () => Promise<SeatResult>;
  onReset: () => Promise<SeatResult>;
  onRemove: (targetId: string) => Promise<SeatResult>;
  onClaim: (hostKey: string) => Promise<string>;
  onLeave: () => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [claimKey, setClaimKey] = useState("");
  const [claimOpen, setClaimOpen] = useState(false);
  const [blastId, setBlastId] = useState<string | null>(null);
  const heartsSeen = useRef<Map<string, number> | null>(null);
  const blastQueue = useRef<string[]>([]);
  const locked = room.you.vote !== null;
  const countdown = useCountdown(room.timer);
  const open =
    room.timer.phase === "paused" || (room.timer.phase === "running" && countdown.ms > 0);

  useEffect(() => {
    const seen = heartsSeen.current;
    const fresh = new Map<string, number>();
    const hit: string[] = [];
    for (const player of room.players) {
      fresh.set(player.id, player.hearts);
      if (seen && (seen.get(player.id) ?? 0) > 0 && player.hearts === 0) hit.push(player.id);
    }
    heartsSeen.current = fresh;
    if (!seen || hit.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const [first, ...rest] = hit;
    if (!first) return;
    blastQueue.current.push(...rest);
    setBlastId((current) => current ?? first);
  }, [room.players]);

  useEffect(() => {
    if (!blastId) return;
    const timer = window.setTimeout(() => {
      setBlastId(blastQueue.current.shift() ?? null);
    }, 1700);
    return () => window.clearTimeout(timer);
  }, [blastId]);

  async function vote(voteValue: Vote) {
    if (sending || locked || !open) return;
    setSending(true);
    await onVote(voteValue);
    setSending(false);
  }

  async function next() {
    if (sending) return;
    setSending(true);
    await onNext();
    setSending(false);
  }

  return (
    <>
    <main className="relative z-10 mx-auto grid min-h-dvh w-full max-w-[1180px] grid-cols-1 gap-6 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:px-8 lg:py-6">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 lg:col-span-2">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <Alien className="h-14 w-11 shrink-0" />
            <p className="font-display text-2xl tracking-tight">Never have I ever</p>
          </div>
          <p className="mt-1 text-sm text-muted">
            Table {room.code}
            <span className="px-2" aria-hidden="true">
              /
            </span>
            <span>{link === "live" ? "Live" : "Reconnecting"}</span>
            <span className="tabular-nums">
              <span className="px-2" aria-hidden="true">
                /
              </span>
              Round {room.roundId}
            </span>
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {room.you.name}
              {room.you.isHost ? <span className="text-muted"> · Host</span> : null}
            </p>
            <div className="mt-1">
              <Hearts hearts={room.you.hearts} />
            </div>
          </div>
          <button
            type="button"
            className="press h-11 rounded-xl border-[3px] border-ink px-4 text-sm font-medium"
            onClick={() => void onLeave()}
          >
            Leave
          </button>
        </div>
      </header>

      <section className="relative min-w-0">
        <p className="turn-call mb-5" aria-live="polite">
          {room.turnName ? `It's your turn, ${room.turnName}!` : "\u00a0"}
        </p>
        <article className="panel bubble relative bg-paper px-6 py-10 text-center text-paper-foreground sm:px-10 sm:py-12">
          <h2 key={room.roundId} className="statement statement-in" aria-live="polite">
            Never have I ever...
          </h2>
          {room.timer.phase !== "idle" ? (
            <p className="mt-5 font-display text-6xl leading-none tabular-nums text-ink" aria-live="polite">
              {countdown.seconds}
            </p>
          ) : null}
          {room.timer.phase === "paused" ? <p className="mt-2 text-sm font-medium">Paused</p> : null}
        </article>

        <p className="mt-6 text-sm tabular-nums text-muted">
          {room.answered} of {room.players.length} have answered
        </p>

        {room.you.hearts === 0 ? (
          <p className="mt-3 text-sm text-muted">
            You're out of hearts. You can still answer, and you can still say the next never.
          </p>
        ) : null}

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <button
            type="button"
            className={`choice press min-h-20 bg-never px-4 text-lg font-medium leading-snug text-never-foreground ${
              room.you.vote === "never" ? "is-picked" : ""
            } ${!open || (locked && room.you.vote !== "never") ? "opacity-40" : ""}`}
            disabled={!open || locked || sending}
            aria-pressed={room.you.vote === "never"}
            onClick={() => void vote("never")}
          >
            I have also never done this
          </button>
          <button
            type="button"
            className={`choice press min-h-20 bg-done px-4 text-lg font-medium leading-snug text-done-foreground ${
              room.you.vote === "done" ? "is-picked" : ""
            } ${!open || (locked && room.you.vote !== "done") ? "opacity-40" : ""}`}
            disabled={!open || locked || sending}
            aria-pressed={room.you.vote === "done"}
            onClick={() => void vote("done")}
          >
            I have done this
          </button>
        </div>

        {!open && !locked ? (
          <p className="mt-4 text-sm text-muted">Buttons open when the host starts the timer.</p>
        ) : null}
        {room.you.vote === "never" ? (
          <p className="mt-4 text-sm text-muted">Locked in. Your hearts stay where they are.</p>
        ) : null}
        {room.you.vote === "done" ? (
          <p className="mt-4 text-sm text-muted">
            {room.you.hearts === 0 ? "Locked in. No hearts left to lose." : "Locked in. That one cost a heart."}
          </p>
        ) : null}

        {banner ? (
          <p className="mt-4 text-sm text-star" role="alert">
            {banner}
          </p>
        ) : null}

        {room.you.isHost ? (
          <div className="panel mt-8 p-5 sm:p-6">
            <h3 className="font-medium">The round</h3>
            <p className="mt-1 text-sm leading-normal text-muted">
              When everyone is aboard, start the game. That locks the names and shuffles the order. After the person whose turn it is says their Never Have I Ever, start the 10 seconds. At zero, the answers stay up until you press Next Player. Restart puts that clock back to 10. Pause if someone asks a question.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {!room.started ? (
                <button
                  type="button"
                  className="pop press h-11 bg-star px-4 text-sm font-medium text-ink disabled:opacity-50"
                  disabled={sending}
                  onClick={() => void onStart()}
                >
                  Start Game
                </button>
              ) : null}
              {room.started && room.timer.phase === "idle" ? (
                <button
                  type="button"
                  className="pop press h-11 bg-star px-4 text-sm font-medium text-ink disabled:opacity-50"
                  disabled={sending}
                  onClick={() => void onTimer("start")}
                >
                  Start timer
                </button>
              ) : null}
              {room.timer.phase === "running" || room.timer.phase === "paused" ? (
                <button
                  type="button"
                  className="pop press h-11 bg-paper px-4 text-sm font-medium text-paper-foreground disabled:opacity-50"
                  disabled={sending}
                  onClick={() => void onTimer("restart")}
                >
                  Restart timer
                </button>
              ) : null}
              {room.timer.phase === "running" ? (
                <button
                  type="button"
                  className="pop press h-11 bg-paper px-4 text-sm font-medium text-paper-foreground disabled:opacity-50"
                  disabled={sending}
                  onClick={() => void onTimer("toggle")}
                >
                  Pause
                </button>
              ) : null}
              {room.timer.phase === "paused" ? (
                <button
                  type="button"
                  className="pop press h-11 bg-star px-4 text-sm font-medium text-ink disabled:opacity-50"
                  disabled={sending}
                  onClick={() => void onTimer("toggle")}
                >
                  Resume
                </button>
              ) : null}
              <button
                type="button"
                className="pop press h-11 bg-paper px-4 text-sm font-medium text-paper-foreground disabled:opacity-50"
                disabled={sending}
                onClick={() => void next()}
              >
                Next never
              </button>
              {confirmReset ? (
                <>
                  <p className="text-sm text-muted">Everyone back to 10 hearts?</p>
                  <button
                    type="button"
                    className="pop press h-11 bg-done px-4 text-sm font-medium text-done-foreground"
                    onClick={() => {
                      setConfirmReset(false);
                      void onReset();
                    }}
                  >
                    Reset hearts
                  </button>
                  <button
                    type="button"
                    className="press h-11 rounded-xl px-3 text-sm text-muted"
                    onClick={() => setConfirmReset(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="press h-11 rounded-xl px-1 text-sm text-muted"
                  onClick={() => setConfirmReset(true)}
                >
                  Reset hearts
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-8">
            <button
              type="button"
              className="text-sm text-muted underline-offset-4 hover:underline"
              onClick={() => setClaimOpen((openNow) => !openNow)}
            >
              Hosting the ship?
            </button>
            {claimOpen ? (
              <form
                className="mt-3 flex flex-col gap-3 sm:flex-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  void (async () => {
                    const message = await onClaim(claimKey);
                    if (!message) {
                      setClaimKey("");
                      setClaimOpen(false);
                    }
                  })();
                }}
              >
                <label className="sr-only" htmlFor="claim-key">
                  Host key
                </label>
                <input
                  id="claim-key"
                  className="field sm:max-w-xs"
                  type="password"
                  value={claimKey}
                  placeholder="Host key"
                  autoComplete="off"
                  onChange={(event) => setClaimKey(event.target.value)}
                />
                <button type="submit" className="pop press h-11 bg-paper px-4 text-sm font-medium text-paper-foreground">
                  Use this laptop
                </button>
              </form>
            ) : null}
          </div>
        )}
      </section>

      <aside className="board-pane panel min-w-0">
        <div className="border-b-[3px] border-ink px-5 py-4">
          <h2 className="font-medium">The crew</h2>
          <p className="mt-1 text-sm text-muted">
            <span className="tabular-nums">{room.players.length}</span> aboard · most hearts at the top
          </p>
        </div>
        <ol className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {room.players.map((player, index) => {
            const mine = player.id === room.you.id;
            const zapping = blastId === player.id;
            const out = player.hearts === 0 && !zapping;
            return (
              <li
                key={player.id}
                className={`crew-row flex items-center gap-3 rounded-xl px-3 py-2 ${out ? "is-out" : ""} ${zapping ? "is-zapped" : ""} ${mine ? "you-row" : ""}`}
              >
                {zapping ? <ShipZap /> : null}
                <span className="w-6 shrink-0 text-sm tabular-nums text-muted">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`crew-name truncate text-sm font-medium ${zapping ? "is-zapped" : ""} ${out ? "is-out" : ""}`}>
                    {player.name}
                    {mine ? <span className="text-muted"> · You</span> : null}
                    {player.isHost ? <span className="text-muted"> · Host</span> : null}
                    {player.hearts === 0 ? <span className="text-muted"> · Out</span> : null}
                    {player.away ? <span className="text-muted"> · Away</span> : null}
                    {player.id === room.turnId ? <span className="text-star"> · Turn</span> : null}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <Pips hearts={player.hearts} />
                    <span className="flex items-center gap-1.5 text-xs text-muted">
                      <span
                        className={
                          player.vote === "done"
                            ? "inline-block size-2 rounded-full border-2 border-ink bg-done"
                            : player.vote === "never"
                              ? "inline-block size-2 rounded-full border-2 border-ink bg-never"
                              : "inline-block size-2 rounded-full border-2 border-ink bg-transparent"
                        }
                        aria-hidden="true"
                      />
                      {player.vote === "done" ? "Did it" : player.vote === "never" ? "Never" : "Waiting"}
                    </span>
                  </div>
                </div>
                <span
                  className={`w-6 shrink-0 text-right text-sm font-medium tabular-nums ${
                    player.hearts === 0 ? "text-muted" : ""
                  }`}
                >
                  {player.hearts}
                </span>
                {room.you.isHost && !mine ? (
                  <button
                    type="button"
                    className="press h-8 shrink-0 rounded-lg px-2 text-xs text-muted"
                    onClick={() => {
                      if (pendingRemove === player.id) {
                        setPendingRemove(null);
                        void onRemove(player.id);
                      } else {
                        setPendingRemove(player.id);
                      }
                    }}
                  >
                    {pendingRemove === player.id ? "Confirm" : "Remove"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
        <p className="border-t-[3px] border-ink px-5 py-3 text-xs leading-normal text-muted">
          Out of hearts? You can still say the next never out loud.
        </p>
      </aside>
    </main>
    {room.started && room.timer.phase === "done" ? (
      <Reveal room={room} sending={sending} onNext={() => void next()} />
    ) : null}
    </>
  );
}

function Reveal({
  room,
  sending,
  onNext,
}: {
  room: RoomView;
  sending: boolean;
  onNext: () => void;
}) {
  const nots = room.players.filter((player) => player.vote === "never");
  const haves = room.players.filter((player) => player.vote === "done");
  const silent = room.players.filter((player) => player.vote === null);

  return (
    <div className="fixed inset-3 z-40 flex flex-col overflow-hidden rounded-xl border-4 border-ink bg-ink sm:inset-4" role="dialog" aria-label="How everyone answered">
      <div className="grid min-h-0 flex-1 grid-cols-2">
        <section className="flex min-h-0 flex-col bg-never text-never-foreground">
          <h2 className="border-b-4 border-ink px-4 py-4 font-display text-3xl leading-none sm:px-6 sm:text-5xl">Have Nots</h2>
          <ul className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
            {nots.map((player) => (
              <li key={player.id} className="border-b-2 border-ink/25 py-2 text-lg font-medium sm:text-2xl">
                {player.name}
              </li>
            ))}
            {nots.length === 0 ? <li className="py-2 text-lg">Nobody</li> : null}
          </ul>
        </section>
        <section className="flex min-h-0 flex-col border-l-4 border-ink bg-done text-done-foreground">
          <h2 className="border-b-4 border-ink px-4 py-4 font-display text-3xl leading-none sm:px-6 sm:text-5xl">Haves</h2>
          <ul className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
            {haves.map((player) => (
              <li key={player.id} className="border-b-2 border-white/30 py-2 text-lg font-medium sm:text-2xl">
                {player.name}
              </li>
            ))}
            {haves.length === 0 ? <li className="py-2 text-lg">Nobody</li> : null}
          </ul>
        </section>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t-4 border-ink bg-paper px-4 py-4 text-paper-foreground sm:px-6">
        <p className="text-sm">
          {silent.length > 0 ? `No answer: ${silent.map((player) => player.name).join(", ")}` : "Everyone answered."}
        </p>
        {room.you.isHost ? (
          <button
            type="button"
            className="pop press h-12 bg-star px-5 text-base font-medium text-ink disabled:opacity-50"
            disabled={sending}
            onClick={onNext}
          >
            Next Player
          </button>
        ) : (
          <p className="text-sm">Waiting for the host.</p>
        )}
      </footer>
    </div>
  );
}

function ShipZap() {
  return (
    <div className="ship-zap" aria-hidden="true">
      <span className="ship-beam" />
      <span className="ship-hit" />
      <svg viewBox="0 0 120 70" className="ship-body">
        <g stroke="#101428" strokeWidth="3" strokeLinejoin="round">
          <polygon points="18,36 42,58 8,58" fill="#ffe14a" />
          <ellipse cx="62" cy="40" rx="48" ry="14" fill="#d63d74" />
          <ellipse cx="62" cy="34" rx="48" ry="12" fill="#ff5fa2" />
          <path d="M18 34 H106" stroke="#ffe14a" strokeWidth="4" />
          <path d="M34 32 Q62 6 90 32 Z" fill="#9be7ff" />
          <circle cx="62" cy="22" r="7" fill="#3ddc84" />
          <circle cx="59" cy="21" r="1.4" fill="#101428" stroke="none" />
          <circle cx="65" cy="21" r="1.4" fill="#101428" stroke="none" />
          <circle cx="28" cy="36" r="3" fill="#ffe14a" />
          <circle cx="96" cy="36" r="3" fill="#ffe14a" />
        </g>
      </svg>
    </div>
  );
}

function useCountdown(timer: { phase: string; remainingMs: number }) {
  const anchor = useRef({ remainingMs: timer.remainingMs, at: Date.now() });
  const [, setTick] = useState(0);

  useEffect(() => {
    anchor.current = { remainingMs: timer.remainingMs, at: Date.now() };
    setTick((n) => n + 1);
  }, [timer.phase, timer.remainingMs]);

  useEffect(() => {
    if (timer.phase !== "running") return;
    const id = window.setInterval(() => setTick((n) => n + 1), 100);
    return () => window.clearInterval(id);
  }, [timer.phase]);

  const elapsed = timer.phase === "running" ? Date.now() - anchor.current.at : 0;
  const ms = Math.max(0, anchor.current.remainingMs - elapsed);
  return { ms, seconds: ms <= 0 ? 0 : Math.ceil(ms / 1000) };
}

function Alien({ className }: { className?: string }) {
  return (
    <svg viewBox="-6 -2 148 176" className={className} aria-hidden="true">
      <AlienGraphic />
    </svg>
  );
}

function AlienGraphic() {
  return (
    <g stroke="#101428" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path d="M42 40 C28 16 16 18 18 6" fill="none" />
      <circle cx="16" cy="8" r="7" fill="#ffe14a" />
      <circle cx="14" cy="6" r="2" fill="#fff6c2" stroke="none" />
      <path d="M78 40 C94 14 110 18 106 4" fill="none" />
      <circle cx="108" cy="6" r="7" fill="#ffe14a" />
      <circle cx="106" cy="4" r="2" fill="#fff6c2" stroke="none" />
      <path d="M20 66 Q4 82 18 102 Q30 90 26 74 Z" fill="#1fa86a" />
      <path d="M100 66 Q116 82 102 102 Q90 90 94 74 Z" fill="#1fa86a" />
      <path d="M48 112 H72 L76 128 H44 Z" fill="#3ddc84" />
      <path
        d="M24 56 Q14 84 28 110 Q48 130 60 130 Q72 130 92 110 Q106 84 96 56 Q82 32 60 30 Q38 32 24 56 Z"
        fill="#3ddc84"
      />
      <path d="M86 68 Q102 90 90 112 Q78 120 70 114 Q88 98 82 74 Z" fill="#1fa86a" stroke="none" />
      <circle cx="46" cy="50" r="2.2" fill="#147a48" stroke="none" />
      <circle cx="60" cy="46" r="2.6" fill="#147a48" stroke="none" />
      <circle cx="74" cy="50" r="2.2" fill="#147a48" stroke="none" />
      <ellipse cx="44" cy="74" rx="15" ry="17" fill="#f4fff6" />
      <ellipse cx="78" cy="74" rx="15" ry="17" fill="#f4fff6" />
      <ellipse cx="46" cy="76" rx="7.5" ry="8.5" fill="#16324c" stroke="none" />
      <ellipse cx="80" cy="76" rx="7.5" ry="8.5" fill="#16324c" stroke="none" />
      <circle cx="49" cy="73" r="2.6" fill="#ffffff" stroke="none" />
      <circle cx="83" cy="73" r="2.6" fill="#ffffff" stroke="none" />
      <path d="M30 64 Q44 54 58 66" fill="none" />
      <path d="M64 66 Q78 54 94 64" fill="none" />
      <path d="M56 92 Q60 96 64 92" fill="none" />
      <path d="M46 100 Q60 112 76 100" fill="none" />
      <path d="M52 102 Q60 108 68 102 Q60 104 52 102 Z" fill="#143028" stroke="none" />
      <path d="M34 128 Q24 150 40 162 H80 Q96 150 86 128 Q72 140 60 140 Q48 140 34 128 Z" fill="#24367a" />
      <path d="M46 126 H74 L70 132 H50 Z" fill="#101428" />
      <path d="M54 134 H66 L64 148 H56 Z" fill="#ffe14a" />
      <circle cx="60" cy="140" r="3" fill="#ff5fa2" stroke="none" />
      <path d="M34 136 Q14 128 10 112" fill="none" strokeWidth="7" />
      <circle cx="10" cy="106" r="8" fill="#3ddc84" />
      <path d="M6 100 L2 92 M10 98 L10 88 M15 100 L20 94" fill="none" strokeWidth="2.4" />
      <path d="M86 136 Q106 130 114 146" fill="none" strokeWidth="7" />
      <circle cx="116" cy="150" r="8" fill="#3ddc84" />
      <path d="M112 156 L108 164 M116 158 L118 166 M122 154 L130 160" fill="none" strokeWidth="2.4" />
      <path d="M42 158 H58 L60 164 H38 Z" fill="#101428" />
      <path d="M64 158 H82 L86 164 H62 Z" fill="#101428" />
    </g>
  );
}

function SkyBits() {
  return (
    <svg className="comic-sky" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g stroke="#3d5cb5" strokeWidth="3" fill="none">
        <path d="M500 0 L450 120" />
        <path d="M590 0 L640 140" />
        <path d="M700 10 L780 150" />
      </g>
      <g transform="translate(1020 70) scale(0.9)">
        <Planet />
      </g>
      <g transform="translate(8 620) scale(0.85)">
        <SaucerGraphic />
      </g>
      <g transform="translate(520 18)" stroke="#101428" strokeWidth="4" strokeLinejoin="round">
        <polygon points="0,18 48,0 40,22 88,28 40,36 48,58 0,40 -8,58 -16,36 -56,28 -16,22 -8,0" fill="#ff8fb3" />
        <circle cx="70" cy="28" r="16" fill="#ffe14a" />
        <path d="M78 20 L96 8" stroke="#fff6c2" strokeWidth="3" />
      </g>
      <Star x={90} y={180} />
      <Star x={340} y={70} />
      <Star x={760} y={590} />
      <Star x={900} y={460} />
    </svg>
  );
}

function Star({ x, y }: { x: number; y: number }) {
  return (
    <polygon
      transform={`translate(${x} ${y})`}
      points="0,-18 3,-5 16,-8 6,0 14,14 0,6 -14,14 -6,0 -16,-8 -3,-5"
      fill="#ffe14a"
      stroke="#101428"
      strokeWidth="3"
    />
  );
}

function Planet() {
  return (
    <g stroke="#101428" strokeWidth="3">
      <path d="M-110 18 Q0 58 110 18" fill="none" stroke="#e2b23a" strokeWidth="14" />
      <circle r="70" fill="#7eb6ff" />
      <path d="M-40 -20 Q-10 -48 28 -18 Q6 4 -36 2 Z" fill="#5b93e6" stroke="none" />
      <path d="M10 16 Q36 8 48 28 Q30 42 8 34 Z" fill="#d7ebff" stroke="none" />
      <circle cx="-24" cy="-8" r="14" fill="#4e86dc" />
      <path d="M-32 -14 Q-24 -4 -16 -14" fill="none" stroke="#d7ebff" strokeWidth="2" />
      <circle cx="30" cy="22" r="8" fill="#4e86dc" />
      <circle cx="8" cy="-36" r="5" fill="#d7ebff" stroke="none" />
      <circle cx="-46" cy="24" r="4" fill="#16324c" stroke="none" />
      <path d="M-62 -8 H62 M-66 16 H66" fill="none" stroke="#16324c" strokeWidth="2" opacity="0.35" />
      <path d="M-96 28 Q0 64 96 28" fill="none" stroke="#ffe14a" strokeWidth="10" />
      <circle cx="92" cy="-46" r="10" fill="#fff1d0" />
      <circle cx="88" cy="-48" r="3" fill="#e7d7a8" stroke="none" />
    </g>
  );
}

function SaucerGraphic() {
  return (
    <g stroke="#101428" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <polygon points="150,86 236,158 64,158" fill="#ffe9a0" />
      <path d="M118 98 L96 156 M150 90 L150 158 M182 98 L206 156" fill="none" stroke="#e2c15a" strokeWidth="3" />
      <ellipse cx="150" cy="96" rx="132" ry="28" fill="#d63d74" />
      <ellipse cx="150" cy="84" rx="132" ry="24" fill="#ff5fa2" />
      <path d="M28 84 H272" stroke="#ffe14a" strokeWidth="5" />
      <path d="M36 96 Q150 118 264 96" fill="none" stroke="#a61f55" strokeWidth="3" />
      {[64, 98, 206, 240].map((x) => (
        <circle key={x} cx={x} cy="84" r="5" fill="#ffe14a" />
      ))}
      <circle cx="150" cy="90" r="6" fill="#fff1d0" />
      <path d="M92 78 Q150 4 208 78 Z" fill="#c9f4ff" />
      <path d="M118 70 Q146 28 170 52" fill="none" stroke="#ffffff" strokeWidth="5" />
      <path d="M126 36 C112 16 128 8 124 2" fill="none" />
      <circle cx="122" cy="4" r="5" fill="#ffe14a" />
      <path d="M168 34 C184 12 176 6 186 2" fill="none" />
      <circle cx="188" cy="3" r="5" fill="#ffe14a" />
      <path d="M132 58 Q150 46 168 58 Q164 74 150 78 Q136 74 132 58 Z" fill="#3ddc84" />
      <ellipse cx="142" cy="62" rx="6" ry="7" fill="#f4fff6" />
      <ellipse cx="160" cy="62" rx="6" ry="7" fill="#f4fff6" />
      <circle cx="143" cy="63" r="2.4" fill="#16324c" stroke="none" />
      <circle cx="161" cy="63" r="2.4" fill="#16324c" stroke="none" />
      <circle cx="144" cy="62" r="1" fill="#ffffff" stroke="none" />
      <circle cx="162" cy="62" r="1" fill="#ffffff" stroke="none" />
      <path d="M146 72 Q150 75 154 72" fill="none" />
      <path d="M118 74 Q108 88 116 78" fill="#3ddc84" />
      <ellipse cx="78" cy="108" rx="18" ry="11" fill="#24367a" />
      <ellipse cx="78" cy="108" rx="9" ry="5" fill="#9be7ff" />
      <ellipse cx="150" cy="114" rx="20" ry="12" fill="#24367a" />
      <ellipse cx="150" cy="114" rx="10" ry="6" fill="#ffe14a" />
      <ellipse cx="222" cy="108" rx="18" ry="11" fill="#24367a" />
      <ellipse cx="222" cy="108" rx="9" ry="5" fill="#ff8fb3" />
      <path d="M86 112 L74 132 H98" fill="none" />
      <path d="M214 112 L202 132 H230" fill="none" />
    </g>
  );
}

function PanelScene() {
  return (
    <svg viewBox="0 0 640 220" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="640" height="220" fill="#152056" />
      <g stroke="#3d5cb5" strokeWidth="3" fill="none">
        <path d="M0 18 H180" />
        <path d="M460 22 H640" />
        <path d="M0 200 H120" />
      </g>
      <ellipse cx="360" cy="200" rx="220" ry="14" fill="#2a3a86" stroke="#101428" strokeWidth="3" />
      <g transform="translate(575 64) scale(0.42)">
        <Planet />
      </g>
      <g transform="translate(-16 52) scale(0.58)">
        <SaucerGraphic />
      </g>
      <g transform="translate(318 22)">
        <AlienGraphic />
      </g>
      <Star x={250} y={36} />
      <g stroke="#101428" strokeWidth="3">
        <path d="M560 176 L548 196 H578 Z" fill="#8d97b8" />
        <path d="M590 168 L576 196 H608 Z" fill="#b7c0da" />
      </g>
    </svg>
  );
}
