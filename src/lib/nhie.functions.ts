import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import type { PlayerView, RoomView, SeatResult, TimerPhase, Vote } from "@/lib/nhie-types";

const LINE = "Never have I ever...";
const TABLE = "RICK";
const MAX_PLAYERS = 40;
const ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{48}$/i;

type Sql = Awaited<ReturnType<typeof getSql>>;

type PlayerRow = {
  id: string;
  name: string;
  hearts: number | string;
  is_host: boolean | number | string | null;
  vote: string | null;
  away: boolean | number | string | null;
};

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true";
}

function parseVote(value: string | null): Vote | null {
  return value === "never" || value === "done" ? value : null;
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > 20) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '’\.\-]*$/u.test(name)) return null;
  return name;
}

function seatOf(data: { id?: unknown; token?: unknown }): { id: string; token: string } | null {
  if (typeof data.id !== "string" || typeof data.token !== "string") return null;
  if (!ID_RE.test(data.id) || !TOKEN_RE.test(data.token)) return null;
  return { id: data.id, token: data.token };
}

function hostKeyOk(input: unknown): boolean {
  return typeof input === "string" && input.trim().toUpperCase() === "NEVER";
}

function isUnique(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unique|duplicate key/i.test(msg);
}

function parsePhase(value: string): TimerPhase {
  if (value === "running" || value === "paused" || value === "done") return value;
  return "idle";
}

function parseOrder(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function shuffle(ids: string[]): string[] {
  const next = [...ids];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = next[i];
    next[i] = next[j] ?? next[i];
    next[j] = swap ?? next[j];
  }
  return next;
}

async function advanceTurn(sql: Sql, roomCode: string): Promise<void> {
  const rooms = await sql<{
    started: boolean | number | string | null;
    turn_order: string;
    turn_index: number | string;
  }>`
    select started, turn_order, turn_index from nhie_room where code = ${roomCode}
  `;
  const room = rooms[0];
  if (!room) return;

  let index = Number(room.turn_index) || 0;
  if (flag(room.started)) {
    const order = parseOrder(room.turn_order);
    const liveRows = await sql<{ id: string }>`
      select id from nhie_player where room_code = ${roomCode}
    `;
    const live = new Set(liveRows.map((row) => row.id));
    if (order.length > 0) {
      index += 1;
      for (let step = 0; step < order.length; step += 1) {
        const id = order[index % order.length];
        if (id && live.has(id)) break;
        index += 1;
      }
    }
  }

  await sql`
    update nhie_room
    set timer_phase = 'idle',
        timer_deadline = null,
        timer_remaining_ms = 10000,
        turn_index = ${index},
        round_id = greatest(round_id, 1) + 1,
        updated_at = now()
    where code = ${roomCode}
  `;
  await sql`update nhie_player set vote = null where room_code = ${roomCode}`;
}

async function repairTurn(sql: Sql, roomCode: string): Promise<void> {
  const rooms = await sql<{
    started: boolean | number | string | null;
    turn_order: string;
    turn_index: number | string;
  }>`
    select started, turn_order, turn_index from nhie_room where code = ${roomCode}
  `;
  const room = rooms[0];
  if (!room || !flag(room.started)) return;
  const order = parseOrder(room.turn_order);
  if (order.length === 0) return;
  const liveRows = await sql<{ id: string }>`
    select id from nhie_player where room_code = ${roomCode}
  `;
  const live = new Set(liveRows.map((row) => row.id));
  let index = Number(room.turn_index) || 0;
  const current = order[((index % order.length) + order.length) % order.length];
  if (current && live.has(current)) return;
  for (let step = 0; step < order.length; step += 1) {
    index += 1;
    const id = order[((index % order.length) + order.length) % order.length];
    if (id && live.has(id)) {
      await sql`
        update nhie_room set turn_index = ${index}, updated_at = now() where code = ${roomCode}
      `;
      return;
    }
  }
}

async function settleTimer(sql: Sql, roomCode: string): Promise<void> {
  await sql`
    update nhie_room
    set timer_phase = 'done',
        timer_remaining_ms = 0,
        timer_deadline = null,
        updated_at = now()
    where code = ${roomCode}
      and timer_phase = 'running'
      and timer_deadline is not null
      and timer_deadline <= now()
  `;
}
async function snapshot(sql: Sql, roomCode: string, selfId: string): Promise<RoomView | null> {
  await settleTimer(sql, roomCode);
  await repairTurn(sql, roomCode);
  const rooms = await sql<{
    statement: string;
    round_id: number | string;
    timer_phase: string;
    remaining_ms: number | string;
    started: boolean | number | string | null;
    turn_order: string;
    turn_index: number | string;
  }>`
    select statement, round_id, timer_phase, started, turn_order, turn_index,
           case
             when timer_phase = 'running' and timer_deadline is not null
               then greatest(0, (extract(epoch from (timer_deadline - now())) * 1000))::int
             else timer_remaining_ms
           end as remaining_ms
    from nhie_room
    where code = ${roomCode}
  `;
  const room = rooms[0];
  if (!room) return null;

  if (Number(room.round_id) < 1 || room.statement !== LINE) {
    await sql`
      update nhie_room
      set statement = ${LINE},
          round_id = greatest(round_id, 1),
          updated_at = now()
      where code = ${roomCode}
    `;
    room.statement = LINE;
    room.round_id = Math.max(Number(room.round_id), 1);
  }

  const rows = await sql<PlayerRow>`
    select id, name, hearts, is_host, vote,
           (last_seen < now() - interval '20 seconds') as away
    from nhie_player
    where room_code = ${roomCode}
    order by hearts desc, lower(name) asc, id asc
  `;

  const players: PlayerView[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    hearts: Number(row.hearts),
    vote: parseVote(row.vote),
    isHost: flag(row.is_host),
    away: flag(row.away),
  }));

  const you = players.find((player) => player.id === selfId);
  if (!you) return null;

  const answered = players.filter((player) => player.vote !== null).length;
  const order = flag(room.started) ? parseOrder(room.turn_order) : [];
  const index = Number(room.turn_index) || 0;
  const turnId = order.length > 0 ? (order[((index % order.length) + order.length) % order.length] ?? null) : null;
  const turnName = turnId ? (players.find((player) => player.id === turnId)?.name ?? null) : null;

  return {
    code: roomCode,
    statement: LINE,
    roundId: Number(room.round_id),
    answered,
    previous: [],
    timer: {
      phase: parsePhase(room.timer_phase),
      remainingMs: Number(room.remaining_ms),
    },
    started: flag(room.started),
    turnId,
    turnName,
    you,
    players,
  };
}

async function touch(
  sql: Sql,
  id: string,
  token: string,
): Promise<{ roomCode: string; isHost: boolean } | null> {
  const rows = await sql<{ room_code: string; is_host: boolean | number | string | null }>`
    update nhie_player
    set last_seen = now()
    where id = ${id} and token = ${token}
    returning room_code, is_host
  `;
  const row = rows[0];
  if (!row) return null;
  return { roomCode: row.room_code, isHost: flag(row.is_host) };
}

async function promote(sql: Sql, roomCode: string, id: string): Promise<void> {
  await sql`
    update nhie_player set is_host = false
    where room_code = ${roomCode} and id <> ${id}
  `;
  await sql`
    update nhie_player set is_host = true where id = ${id}
  `;
  await sql`
    update nhie_room set host_player_id = ${id}, updated_at = now()
    where code = ${roomCode}
  `;
}

export const joinSeat = createServerFn({ method: "POST" })
  .validator((data: { id: string; token: string; name: string; code: string; hostKey: string; claimHost: boolean }) => data)
  .handler(async ({ data }): Promise<SeatResult> => {
    const seat = seatOf(data);
    const name = cleanName(data.name);
    const code = typeof data.code === "string" ? data.code.trim().toUpperCase() : "";
    if (!seat || !name) return { ok: false, error: "Use a name up to 20 letters." };
    if (code !== TABLE) return { ok: false, error: "That table code isn't open." };
    if (data.claimHost && !hostKeyOk(data.hostKey)) {
      return { ok: false, error: "That host key isn't right." };
    }

    try {
      const sql = await getSql();
      await sql`insert into nhie_room (code) values (${TABLE}) on conflict (code) do nothing`;
      await sql`
        delete from nhie_player
        where room_code = ${TABLE}
          and last_seen < now() - interval '8 hours'
          and id <> ${seat.id}
      `;

      const existing = await sql<{ id: string; token: string }>`
        select id, token from nhie_player where id = ${seat.id}
      `;
      if (existing[0] && existing[0].token !== seat.token) {
        return { ok: false, error: "That seat is already taken. Sit down again." };
      }

      const nameTaken = await sql<{ id: string }>`
        select id from nhie_player
        where room_code = ${TABLE} and lower(name) = lower(${name}) and id <> ${seat.id}
      `;
      if (nameTaken[0]) {
        return { ok: false, error: "Someone already sat down as that name." };
      }

      const state = await sql<{ started: boolean | number | string | null }>`
        select started from nhie_room where code = ${TABLE}
      `;
      const gameOn = flag(state[0]?.started);
      if (gameOn && !existing[0]) {
        return { ok: false, error: "The names are locked. This game has already started." };
      }
      if (gameOn && existing[0]) {
        const current = await sql<{ name: string }>`
          select name from nhie_player where id = ${seat.id}
        `;
        if (current[0] && current[0].name !== name) {
          return { ok: false, error: "The names are locked." };
        }
      }

      if (!existing[0]) {
        const counted = await sql<{ n: number | string }>`
          select count(*)::int as n from nhie_player where room_code = ${TABLE}
        `;
        if (Number(counted[0]?.n ?? 0) >= MAX_PLAYERS) {
          return { ok: false, error: "This table is full." };
        }
        await sql`
          insert into nhie_player (id, room_code, name, token, hearts, is_host)
          values (${seat.id}, ${TABLE}, ${name}, ${seat.token}, 10, false)
        `;
      } else {
        await sql`
          update nhie_player
          set name = ${name}, last_seen = now()
          where id = ${seat.id} and token = ${seat.token}
        `;
      }

      if (data.claimHost) await promote(sql, TABLE, seat.id);

      const room = await snapshot(sql, TABLE, seat.id);
      if (!room) return { ok: false, error: "Couldn't pull up your seat." };
      return { ok: true, room };
    } catch (err) {
      if (isUnique(err)) return { ok: false, error: "Someone already sat down as that name." };
      console.error(err);
      return { ok: false, error: "The table hiccuped. Try again." };
    }
  });

export const syncSeat = createServerFn({ method: "POST" })
  .validator((data: { id: string; token: string }) => data)
  .handler(async ({ data }): Promise<SeatResult> => {
    const seat = seatOf(data);
    if (!seat) return { ok: false, error: "Your seat expired. Sit down again." };
    try {
      const sql = await getSql();
      const player = await touch(sql, seat.id, seat.token);
      if (!player) return { ok: false, error: "Your seat expired. Sit down again." };
      const room = await snapshot(sql, player.roomCode, seat.id);
      if (!room) return { ok: false, error: "Your seat expired. Sit down again." };
      return { ok: true, room };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The table hiccuped. Try again." };
    }
  });

export const castVote = createServerFn({ method: "POST" })
  .validator((data: { id: string; token: string; vote: Vote }) => data)
  .handler(async ({ data }): Promise<SeatResult> => {
    const seat = seatOf(data);
    if (!seat || (data.vote !== "never" && data.vote !== "done")) {
      return { ok: false, error: "That answer didn't register." };
    }
    try {
      const sql = await getSql();
      const player = await touch(sql, seat.id, seat.token);
      if (!player) return { ok: false, error: "Your seat expired. Sit down again." };

      await sql`
        update nhie_room
        set statement = ${LINE},
            round_id = greatest(round_id, 1),
            updated_at = now()
        where code = ${player.roomCode} and round_id < 1
      `;

      await settleTimer(sql, player.roomCode);
      const open = await sql<{ timer_phase: string }>`
        select timer_phase from nhie_room
        where code = ${player.roomCode}
          and timer_phase in ('running', 'paused')
      `;
      if (!open[0]) {
        return { ok: false, error: "Wait for the host to start the timer." };
      }

      if (data.vote === "done") {
        await sql`
          update nhie_player
          set vote = 'done',
              hearts = greatest(0, hearts - 1)
          where id = ${seat.id} and token = ${seat.token} and vote is null
        `;
      } else {
        await sql`
          update nhie_player
          set vote = 'never'
          where id = ${seat.id} and token = ${seat.token} and vote is null
        `;
      }

      const room = await snapshot(sql, player.roomCode, seat.id);
      if (!room) return { ok: false, error: "Your seat expired. Sit down again." };
      return { ok: true, room };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The table hiccuped. Try again." };
    }
  });

export const nextNever = createServerFn({ method: "POST" })
  .validator((data: { id: string; token: string }) => data)
  .handler(async ({ data }): Promise<SeatResult> => {
    const seat = seatOf(data);
    if (!seat) return { ok: false, error: "Your seat expired. Sit down again." };
    try {
      const sql = await getSql();
      const player = await touch(sql, seat.id, seat.token);
      if (!player) return { ok: false, error: "Your seat expired. Sit down again." };
      if (!player.isHost) return { ok: false, error: "Only the host can start the next never." };
      await advanceTurn(sql, player.roomCode);

      const room = await snapshot(sql, player.roomCode, seat.id);
      if (!room) return { ok: false, error: "Couldn't update the table." };
      return { ok: true, room };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The table hiccuped. Try again." };
    }
  });

export const startGame = createServerFn({ method: "POST" })
  .validator((data: { id: string; token: string }) => data)
  .handler(async ({ data }): Promise<SeatResult> => {
    const seat = seatOf(data);
    if (!seat) return { ok: false, error: "Your seat expired. Sit down again." };
    try {
      const sql = await getSql();
      const player = await touch(sql, seat.id, seat.token);
      if (!player) return { ok: false, error: "Your seat expired. Sit down again." };
      if (!player.isHost) return { ok: false, error: "Only the host can start the game." };

      const seated = await sql<{ id: string }>`
        select id from nhie_player where room_code = ${player.roomCode}
      `;
      if (seated.length < 1) return { ok: false, error: "Wait for someone to sit down." };
      const order = JSON.stringify(shuffle(seated.map((row) => row.id)));
      const locked = await sql<{ code: string }>`
        update nhie_room
        set started = true,
            turn_order = ${order},
            turn_index = 0,
            timer_phase = 'idle',
            timer_deadline = null,
            timer_remaining_ms = 10000,
            updated_at = now()
        where code = ${player.roomCode}
          and started = false
        returning code
      `;
      if (!locked[0]) return { ok: false, error: "The game is already going." };
      await sql`update nhie_player set vote = null where room_code = ${player.roomCode}`;

      const room = await snapshot(sql, player.roomCode, seat.id);
      if (!room) return { ok: false, error: "Couldn't start the game." };
      return { ok: true, room };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The table hiccuped. Try again." };
    }
  });

export const setTimer = createServerFn({ method: "POST" })
  .validator((data: { id: string; token: string; action: "start" | "toggle" | "restart" }) => data)
  .handler(async ({ data }): Promise<SeatResult> => {
    const seat = seatOf(data);
    if (!seat || (data.action !== "start" && data.action !== "toggle" && data.action !== "restart")) {
      return { ok: false, error: "That timer request didn't register." };
    }
    try {
      const sql = await getSql();
      const player = await touch(sql, seat.id, seat.token);
      if (!player) return { ok: false, error: "Your seat expired. Sit down again." };
      if (!player.isHost) return { ok: false, error: "Only the host can run the timer." };
      await settleTimer(sql, player.roomCode);

      if (data.action === "start") {
        const gate = await sql<{ started: boolean | number | string | null }>`
          select started from nhie_room where code = ${player.roomCode}
        `;
        if (!flag(gate[0]?.started)) return { ok: false, error: "Start the game first." };
        const started = await sql<{ code: string }>`
          update nhie_room
          set timer_phase = 'running',
              timer_deadline = now() + interval '10 seconds',
              timer_remaining_ms = 10000,
              updated_at = now()
          where code = ${player.roomCode}
            and timer_phase = 'idle'
          returning code
        `;
        if (!started[0]) return { ok: false, error: "The timer is already going." };
      } else if (data.action === "restart") {
        const restarted = await sql<{ code: string }>`
          update nhie_room
          set timer_phase = 'running',
              timer_deadline = now() + interval '10 seconds',
              timer_remaining_ms = 10000,
              updated_at = now()
          where code = ${player.roomCode}
            and started = true
            and timer_phase in ('running', 'paused')
          returning code
        `;
        if (!restarted[0]) return { ok: false, error: "Start the timer first." };
      } else {
        const paused = await sql<{ code: string }>`
          update nhie_room
          set timer_remaining_ms = greatest(0, (extract(epoch from (timer_deadline - now())) * 1000))::int,
              timer_deadline = null,
              timer_phase = case
                when timer_deadline <= now() then 'done'
                else 'paused'
              end,
              updated_at = now()
          where code = ${player.roomCode}
            and timer_phase = 'running'
          returning code
        `;
        if (!paused[0]) {
          const resumed = await sql<{ code: string }>`
            update nhie_room
            set timer_deadline = now() + (timer_remaining_ms * interval '1 millisecond'),
                timer_phase = 'running',
                updated_at = now()
            where code = ${player.roomCode}
              and timer_phase = 'paused'
              and timer_remaining_ms > 0
            returning code
          `;
          if (!resumed[0]) return { ok: false, error: "Start the timer first." };
        }
      }

      const room = await snapshot(sql, player.roomCode, seat.id);
      if (!room) return { ok: false, error: "Couldn't update the timer." };
      return { ok: true, room };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The table hiccuped. Try again." };
    }
  });

export const resetTable = createServerFn({ method: "POST" })
  .validator((data: { id: string; token: string }) => data)
  .handler(async ({ data }): Promise<SeatResult> => {
    const seat = seatOf(data);
    if (!seat) return { ok: false, error: "Your seat expired. Sit down again." };
    try {
      const sql = await getSql();
      const player = await touch(sql, seat.id, seat.token);
      if (!player) return { ok: false, error: "Your seat expired. Sit down again." };
      if (!player.isHost) return { ok: false, error: "Only the host can reset the table." };

      await sql`
        with bumped as (
          update nhie_room
          set statement = ${LINE},
              round_id = 1,
              timer_phase = 'idle',
              timer_deadline = null,
              timer_remaining_ms = 10000,
              updated_at = now()
          where code = ${player.roomCode}
          returning code
        )
        update nhie_player
        set hearts = 10, vote = null
        where room_code in (select code from bumped)
      `;
      await sql`delete from nhie_prompt where room_code = ${player.roomCode}`;

      const room = await snapshot(sql, player.roomCode, seat.id);
      if (!room) return { ok: false, error: "Couldn't reset the table." };
      return { ok: true, room };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The table hiccuped. Try again." };
    }
  });

export const removeSeat = createServerFn({ method: "POST" })
  .validator((data: { id: string; token: string; targetId: string }) => data)
  .handler(async ({ data }): Promise<SeatResult> => {
    const seat = seatOf(data);
    if (!seat || typeof data.targetId !== "string" || data.targetId === seat.id) {
      return { ok: false, error: "Pick someone else to remove." };
    }
    try {
      const sql = await getSql();
      const player = await touch(sql, seat.id, seat.token);
      if (!player) return { ok: false, error: "Your seat expired. Sit down again." };
      if (!player.isHost) return { ok: false, error: "Only the host can remove a player." };

      await sql`
        delete from nhie_player
        where id = ${data.targetId} and room_code = ${player.roomCode}
      `;
      const room = await snapshot(sql, player.roomCode, seat.id);
      if (!room) return { ok: false, error: "Couldn't update the table." };
      return { ok: true, room };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The table hiccuped. Try again." };
    }
  });

export const leaveSeat = createServerFn({ method: "POST" })
  .validator((data: { id: string; token: string }) => data)
  .handler(async ({ data }) => {
    const seat = seatOf(data);
    if (!seat) return { ok: true as const };
    try {
      const sql = await getSql();
      const rows = await sql<{ room_code: string; is_host: boolean | number | string | null }>`
        delete from nhie_player
        where id = ${seat.id} and token = ${seat.token}
        returning room_code, is_host
      `;
      const row = rows[0];
      if (row && flag(row.is_host)) {
        await sql`
          update nhie_room
          set host_player_id = null, updated_at = now()
          where code = ${row.room_code} and host_player_id = ${seat.id}
        `;
      }
      return { ok: true as const };
    } catch (err) {
      console.error(err);
      return { ok: false as const, error: "Couldn't leave the table. Try again." };
    }
  });
