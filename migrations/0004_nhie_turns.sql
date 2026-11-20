alter table nhie_room
  add column if not exists started boolean not null default false,
  add column if not exists turn_order text not null default '[]',
  add column if not exists turn_index integer not null default 0;
