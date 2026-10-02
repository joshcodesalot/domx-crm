const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  BUSINESS_TZ,
  SCHEDULE_TZ,
  expandShiftWindows,
  manilaTimestampSql,
  duringScheduledHoursPredicate,
  scheduleDowJoin,
  shiftLabelInTimeZone,
  isDateWithinWeekSchedule,
} = require('./workSchedule');

const userId = '11111111-1111-4111-8111-111111111111';

function overnightDays() {
  const week = new Map();
  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
    week.set(dayOfWeek, {
      dayOfWeek,
      startTime: '23:00:00',
      endTime: '08:00:00',
    });
  }
  return week;
}

function overnightWeek() {
  return new Map([[userId, overnightDays()]]);
}

describe('shift windows', () => {
  it('stamps a clock with Europe/Berlin unless a timezone is passed', () => {
    assert.equal(
      manilaTimestampSql('2026-09-01', '23:00:00'),
      `(TIMESTAMP '2026-09-01 23:00:00' AT TIME ZONE '${BUSINESS_TZ}')`
    );
    assert.equal(BUSINESS_TZ, 'Europe/Berlin');
    assert.equal(
      manilaTimestampSql('2026-09-01', '23:00', SCHEDULE_TZ),
      `(TIMESTAMP '2026-09-01 23:00:00' AT TIME ZONE 'Asia/Manila')`
    );
  });

  it('keeps default windows on Europe/Berlin without a leading morning spill', async () => {
    const windows = await expandShiftWindows(
      [userId],
      '2026-09-01',
      '2026-09-01',
      overnightWeek()
    );
    assert.equal(windows.length, 1);
    assert.match(windows[0].windowStartSql, /Europe\/Berlin/);
    assert.match(windows[0].windowStartSql, /2026-09-01 23:00:00/);
    assert.match(windows[0].windowEndSql, /2026-09-02 08:00:00/);
    assert.doesNotMatch(windows[0].windowStartSql, /Asia\/Manila/);
  });

  it('stamps windows in a saved Asia/Manila schedule timezone', async () => {
    const schedules = overnightWeek();
    schedules.timeZones = new Map([[userId, SCHEDULE_TZ]]);
    const windows = await expandShiftWindows(
      [userId],
      '2026-09-01',
      '2026-09-01',
      schedules
    );
    assert.equal(windows.length, 1);
    assert.match(windows[0].windowStartSql, /Asia\/Manila/);
    assert.match(windows[0].windowStartSql, /2026-09-01 23:00:00/);
    assert.match(windows[0].windowEndSql, /2026-09-02 08:00:00/);
  });

  it('converts a September Berlin 23:00–08:00 shift to Manila 05:00–14:00', () => {
    const at = new Date('2026-09-15T12:00:00.000Z');
    const week = overnightDays();
    assert.equal(
      shiftLabelInTimeZone(week, BUSINESS_TZ, at).shiftLabel,
      '23:00–08:00'
    );
    assert.equal(
      shiftLabelInTimeZone(week, SCHEDULE_TZ, at).shiftLabel,
      '05:00–14:00'
    );
  });

  it('converts a saved Manila 23:00–08:00 shift into Berlin 17:00–02:00', () => {
    const at = new Date('2026-09-15T12:00:00.000Z');
    const week = overnightDays();
    week.scheduleTimeZone = SCHEDULE_TZ;
    assert.equal(
      shiftLabelInTimeZone(week, BUSINESS_TZ, at).shiftLabel,
      '17:00–02:00'
    );
  });

  it('treats 01:00 Berlin as inside the overnight shift', () => {
    const week = overnightDays();
    assert.equal(
      isDateWithinWeekSchedule(new Date('2026-09-15T23:00:00.000Z'), week),
      true
    );
    assert.equal(
      isDateWithinWeekSchedule(new Date('2026-09-16T10:00:00.000Z'), week),
      false
    );
  });

  it('reads a saved Manila shift instead of Berlin', () => {
    const week = overnightDays();
    week.scheduleTimeZone = SCHEDULE_TZ;
    assert.equal(
      isDateWithinWeekSchedule(new Date('2026-09-15T16:00:00.000Z'), week),
      true
    );
    assert.equal(
      isDateWithinWeekSchedule(new Date('2026-09-16T01:00:00.000Z'), week),
      false
    );
  });

  it('reads each chatter schedule timezone and falls back to Europe/Berlin', () => {
    const predicate = duringScheduledHoursPredicate('m', 'uws');
    const join = scheduleDowJoin('m', 'uws');
    assert.match(predicate, /"scheduleTimeZone"/);
    assert.match(join, /"scheduleTimeZone"/);
    assert.match(predicate, /Europe\/Berlin/);
    assert.match(join, /Europe\/Berlin/);
    assert.match(predicate, /_uws_prev/);
    assert.doesNotMatch(predicate, /Asia\/Manila/);
    assert.doesNotMatch(join, /Asia\/Manila/);
  });
});
