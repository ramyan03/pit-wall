import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import schema from '../schema/track.schema.json';
import { TRACK_SCHEMA_VERSION } from '../src/types';
import { syntheticTrackJson } from './fixtures';

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

describe('track.schema.json', () => {
  it('accepts the synthetic fixture', () => {
    const ok = validate(syntheticTrackJson);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('rejects unknown fields and bad compounds', () => {
    const bad = structuredClone(syntheticTrackJson) as Record<string, unknown>;
    bad['surprise'] = 1;
    (bad['strategies'] as { stints: string[] }[])[0]!.stints = ['X', 'H'];
    expect(validate(bad)).toBe(false);
  });

  it('schema version matches the TS types', () => {
    expect(schema.properties.schemaVersion.const).toBe(TRACK_SCHEMA_VERSION);
  });
});
