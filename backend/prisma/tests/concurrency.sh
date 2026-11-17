#!/usr/bin/env bash
# Real multi-session concurrency checks (needs COMMITTED data, so it cleans up with TRUNCATE at the end).
#   PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=fym bash concurrency.sh
# Each scenario: session A takes the lock and holds its transaction open for 3s;
# session B starts 1s later and must WAIT for A, then fail with the expected error.
set -u
PSQL="psql -X -q -v ON_ERROR_STOP=1 -t -A"
fail=0

U() { printf '00000000-0000-0000-0000-%012x' "$1"; }
FUT="date_trunc('day', now()) + interval '20 days'"

$PSQL -c "
INSERT INTO \"user\"(id,email,password_hash,full_name,updated_at) VALUES
 ('$(U 1)','c1@x.com','h','c1',now()),('$(U 2)','c2@x.com','h','c2',now()),('$(U 3)','c3@x.com','h','c3',now()),('$(U 4)','c4@x.com','h','c4',now());
INSERT INTO city(id,name_ar,name_en) VALUES ('$(U 100)','x','CityC');
INSERT INTO venue(id,owner_id,name,city_id,address,latitude,longitude,updated_at) VALUES ('$(U 101)','$(U 1)','V','$(U 100)','a',31,35,now());
INSERT INTO venue_field(id,venue_id,name,format,capacity,price_per_hour,updated_at) VALUES ('$(U 102)','$(U 101)','F','F7',14,100,now());
INSERT INTO \"match\"(id,organizer_id,type,format,status,title,start_at,end_at,capacity,updated_at) VALUES
 ('$(U 200)','$(U 1)','OPEN_MATCH','F7','OPEN','capacity-race',$FUT + interval '18 hours',$FUT + interval '19 hours',1,now()),
 ('$(U 201)','$(U 1)','OPEN_MATCH','F7','OPEN','overlap-A',$FUT + interval '2 days 18 hours',$FUT + interval '2 days 19 hours',5,now()),
 ('$(U 202)','$(U 1)','OPEN_MATCH','F7','OPEN','overlap-B',$FUT + interval '2 days 18 hours 30 minutes',$FUT + interval '2 days 19 hours 30 minutes',5,now()),
 ('$(U 203)','$(U 1)','OPEN_MATCH','F7','OPEN','capacity-edit-race',$FUT + interval '8 days 18 hours',$FUT + interval '8 days 19 hours',2,now());
INSERT INTO match_participant(match_id,user_id) VALUES ('$(U 203)','$(U 3)');
"

# run NAME  A_SQL  B_SQL  EXPECTED_ERROR_IN_B
run() {
  local name="$1" a="$2" b="$3" expect="$4"
  $PSQL -c "BEGIN; $a; SELECT pg_sleep(3); COMMIT;" >/dev/null 2>"/tmp/fym_a.err" &
  local pa=$!
  sleep 1
  local t0=$(date +%s%N)
  local out; out=$($PSQL -c "$b" 2>&1); local rc=$?
  local ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  wait $pa
  if [ $rc -ne 0 ] && echo "$out" | grep -q "$expect" && [ $ms -ge 1200 ]; then
    echo "PASS  $name  (B waited ${ms}ms, then failed with $expect)"
  else
    echo "FAIL  $name  rc=$rc waited=${ms}ms out=[$out]"; fail=1
  fi
}

run "two approvals race for the last spot" \
    "INSERT INTO match_participant(match_id,user_id) VALUES ('$(U 200)','$(U 2)')" \
    "INSERT INTO match_participant(match_id,user_id) VALUES ('$(U 200)','$(U 3)')" \
    "FYM_MATCH_FULL"

run "same player confirmed in two overlapping matches at once" \
    "INSERT INTO match_participant(match_id,user_id) VALUES ('$(U 201)','$(U 4)')" \
    "INSERT INTO match_participant(match_id,user_id) VALUES ('$(U 202)','$(U 4)')" \
    "conflicting key value violates exclusion constraint"

run "two overlapping booking requests at once" \
    "INSERT INTO booking(source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at) VALUES ('IN_APP','PENDING','$(U 2)','$(U 102)',$FUT + interval '4 days 18 hours',$FUT + interval '4 days 19 hours',100,now())" \
    "INSERT INTO booking(source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at) VALUES ('IN_APP','PENDING','$(U 3)','$(U 102)',$FUT + interval '4 days 18 hours 30 minutes',$FUT + interval '4 days 19 hours 30 minutes',100,now())" \
    "conflicting key value violates exclusion constraint"

run "owner block races a booking request for the same slot" \
    "INSERT INTO booking(source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at) VALUES ('IN_APP','PENDING','$(U 2)','$(U 102)',$FUT + interval '6 days 18 hours',$FUT + interval '6 days 19 hours',100,now())" \
    "INSERT INTO venue_block(venue_field_id,start_at,end_at,created_by_id) VALUES ('$(U 102)',$FUT + interval '6 days 18 hours',$FUT + interval '6 days 19 hours','$(U 1)')" \
    "FYM_BLOCK_CONFLICTS_BOOKING"

run "capacity cut races an approval (cannot drop below confirmed)" \
    "INSERT INTO match_participant(match_id,user_id) VALUES ('$(U 203)','$(U 2)')" \
    "UPDATE \"match\" SET capacity = 1 WHERE id='$(U 203)'" \
    "FYM_CAPACITY_BELOW_CONFIRMED"

# Final state sanity: exactly 1 confirmed in the capacity-race match and it is FULL.
state=$($PSQL -c "SELECT count(*) || ' ' || (SELECT status FROM \"match\" WHERE id='$(U 200)') FROM match_participant WHERE match_id='$(U 200)' AND status='CONFIRMED'")
if [ "$state" = "1 FULL" ]; then echo "PASS  final state: 1 confirmed, match FULL"; else echo "FAIL  final state [$state]"; fail=1; fi

$PSQL -c 'TRUNCATE "user", city, venue, venue_field, "match", match_participant, booking, venue_block, match_request, match_invitation, match_team, booking_event, match_event CASCADE' >/dev/null
exit $fail
