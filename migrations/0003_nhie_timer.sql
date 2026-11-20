alter table nhie_room
  add column if not exists timer_phase text not null default 'idle',
  add column if not exists timer_deadline timestamptz,
  add column if not exists timer_remaining_ms integer not null default 10000;

alter table nhie_room
  drop constraint if exists nhie_room_timer_phase_chk;

alter table nhie_room
  add constraint nhie_room_timer_phase_chk
  check (timer_phase in ('idle', 'running', 'paused', 'done'));
