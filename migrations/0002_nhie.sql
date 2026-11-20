create table if not exists nhie_room (
  code text primary key,
  statement text not null default '',
  round_id integer not null default 0,
  host_player_id text,
  updated_at timestamptz not null default now()
);

create table if not exists nhie_player (
  id text primary key,
  room_code text not null references nhie_room (code),
  name text not null,
  token text not null,
  hearts integer not null default 10,
  is_host boolean not null default false,
  vote text,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  constraint nhie_player_vote_chk check (vote is null or vote in ('never', 'done')),
  constraint nhie_player_hearts_chk check (hearts >= 0 and hearts <= 10)
);

create unique index if not exists nhie_player_room_name_idx
  on nhie_player (room_code, lower(name));

create index if not exists nhie_player_room_idx
  on nhie_player (room_code);

create table if not exists nhie_prompt (
  id serial primary key,
  room_code text not null references nhie_room (code),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists nhie_prompt_room_idx
  on nhie_prompt (room_code, id desc);
