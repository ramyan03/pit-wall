/**
 * Team radio. Race engineers are FICTIONAL (one per team); drivers are real names from the data.
 * Lines are picked deterministically from (lap, driver) so a replay says the same things.
 */
import type { CarState, Compound, RaceEvent, RaceState } from '@pit-wall/engine';

export const ENGINEERS: Record<string, string> = {
  'red-bull': 'Tom Hartley',
  ferrari: 'Luca Moretti',
  mercedes: 'Jonas Weber',
  mclaren: 'Sam Ashworth',
  'racing-bulls': 'Dario Conti',
  audi: 'Felix Brandt',
  alpine: 'Julien Marchand',
  haas: 'Kenji Mori',
  williams: 'Owen Price',
  'aston-martin': 'Harriet Cole',
  cadillac: 'Mike Delgado',
};

export interface RadioLine {
  t: number;
  lap: number;
  /** 'eng' = your race engineer, 'drv' = your driver, 'rc' = race control. */
  who: 'eng' | 'drv' | 'rc';
  text: string;
}

const NAME: Record<Compound, string> = { S: 'softs', M: 'mediums', H: 'hards' };

function pick<T>(options: readonly T[], seed: number): T {
  return options[Math.abs(seed) % options.length]!;
}

export function firstName(fullName: string): string {
  return fullName.split(' ')[0]!;
}

export interface RadioContext {
  me: CarState;
  meName: string;
  state: RaceState;
  /** Full names by code, for "Leclerc has boxed". */
  names: Map<string, string>;
}

function surname(ctx: RadioContext, code: string): string {
  const n = ctx.names.get(code);
  return n ? n.split(' ').slice(1).join(' ') || n : code;
}

/** Radio for one race-control/engine event, from the player's pit wall's point of view. */
export function radioFor(e: RaceEvent, t: number, ctx: RadioContext): RadioLine[] {
  const me = ctx.me;
  const s = e.lap * 31 + me.driver.charCodeAt(0);
  const eng = (text: string): RadioLine => ({ t, lap: e.lap, who: 'eng', text });
  const drv = (text: string): RadioLine => ({ t: t + 1.5, lap: e.lap, who: 'drv', text });
  const near = (code: string) => {
    const c = ctx.state.cars.find((x) => x.driver === code);
    return c ? Math.abs(c.position - me.position) <= 2 : false;
  };
  switch (e.type) {
    case 'race_start':
      return [
        eng(
          pick(
            [
              `Okay ${ctx.meName}, starting P${me.position}. Clean start, look after the tyres into turn one.`,
              `Radio check, ${ctx.meName}. P${me.position} on the grid, ${NAME[me.compound]} on. Let's go.`,
            ],
            s,
          ),
        ),
      ];
    case 'sc_deployed':
      return [
        { t, lap: e.lap, who: 'rc', text: 'SAFETY CAR DEPLOYED' },
        eng(pick(['Safety car, safety car. Delta positive, stay above the delta.', 'Safety car. Stand by, we are thinking about the box.'], s)),
      ];
    case 'vsc_deployed':
      return [
        { t, lap: e.lap, who: 'rc', text: 'VIRTUAL SAFETY CAR DEPLOYED' },
        eng('VSC, VSC. Keep it above the delta. Box window is cheap now.'),
      ];
    case 'sc_ending':
      return [{ t, lap: e.lap, who: 'rc', text: 'SAFETY CAR IN THIS LAP' }, eng('Safety car in this lap. Get the tyres up to temperature.')];
    case 'vsc_ending':
      return [{ t, lap: e.lap, who: 'rc', text: 'VSC ENDING' }];
    case 'red_flag':
      return [{ t, lap: e.lap, who: 'rc', text: 'RED FLAG' }, eng('Red flag, red flag. Come back to the pit lane. Free tyre change.')];
    case 'restart':
      return [{ t, lap: e.lap, who: 'rc', text: 'RACE WILL RESTART' }];
    case 'pit_stop': {
      if (e.driver === me.driver) {
        const out: RadioLine[] = [
          { t: t - 6, lap: e.lap, who: 'eng', text: 'Box, box. Box, box.' },
          eng(
            e.slow
              ? pick(['Sorry, problem on the front left. We lost a couple of seconds.', 'Slow one, sorry. Head down.'], s)
              : `Good stop, ${e.stationary.toFixed(1)}. ${NAME[e.to][0]!.toUpperCase() + NAME[e.to].slice(1)} on. P${me.position}.`,
          ),
        ];
        return out;
      }
      if (near(e.driver)) {
        return [eng(`${surname(ctx, e.driver)} has boxed for ${NAME[e.to]}.`)];
      }
      return [];
    }
    case 'overtake':
      if (e.driver === me.driver) {
        return [eng(pick([`Nice move. P${me.position}.`, `Great job. That's P${me.position}.`, `Yes! Good pass. Keep pushing.`], s))];
      }
      if (e.passed === me.driver) {
        return [drv(pick(['He just drove past me, the tyres are done.', 'No grip! Nothing I can do.', "I can't hold him."], s))];
      }
      return [];
    case 'fastest_lap':
      if (e.driver === me.driver) return [eng(`Purple lap! Fastest lap of the race.`)];
      return [];
    case 'radio':
      // Engine-generated lines for the player (e.g. tyre cliff): rephrase as the driver.
      if (e.driver !== me.driver) return [];
      if (/gone/i.test(e.message)) {
        return [drv(pick(['Tyres are gone, mate. The rears are finished.', "I've got no rears left!", 'These tyres are dead.'], s))];
      }
      return [];
    case 'race_finish':
      return [];
  }
}

/** Periodic gap update from the engineer, every few laps. */
export function gapUpdate(t: number, lap: number, ctx: RadioContext): RadioLine | null {
  if (lap < 3 || lap % 6 !== 0) return null;
  const me = ctx.me;
  const ahead = ctx.state.cars[me.position - 2];
  const behind = ctx.state.cars[me.position];
  const parts: string[] = [];
  if (ahead) parts.push(`Gap to ${surname(ctx, ahead.driver)} ${me.interval.toFixed(1)}`);
  if (behind) parts.push(`${surname(ctx, behind.driver)} ${behind.interval.toFixed(1)} behind`);
  if (!parts.length) return null;
  return { t, lap, who: 'eng', text: parts.join(', ') + '.' };
}

export function finishLine(t: number, lap: number, ctx: RadioContext): RadioLine[] {
  const p = ctx.me.position;
  const s = lap + ctx.me.driver.charCodeAt(1);
  if (ctx.me.status === 'disqualified') {
    return [{ t, lap, who: 'eng', text: "Chequered flag... we didn't use two compounds. That's a disqualification. My fault." }];
  }
  const verdict =
    p === 1 ? 'P1! YES! Get in there!' : p <= 3 ? `P${p}, that's a podium! Brilliant job.` : p <= 10 ? `P${p}, points in the bag. Good work.` : `P${p}. Tough one, we'll look at the data.`;
  return [
    { t, lap, who: 'eng', text: `Chequered flag, ${ctx.meName}. ${verdict}` },
    { t: t + 2, lap, who: 'drv', text: pick(p <= 3 ? ['Woooo! Thank you guys!', 'Unbelievable, team. Thank you!'] : ['Thanks guys.', 'Okay. Copy.'], s) },
  ];
}
