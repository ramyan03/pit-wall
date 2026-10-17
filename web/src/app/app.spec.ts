import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { Tutorial } from './tutorial';

describe('App', () => {
  beforeEach(async () => {
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch; // data never arrives in unit tests
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('opens on the startup screen', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toContain('PIT WALL');
    expect(el.textContent).toContain('Start the session');
    expect(el.querySelectorAll('.lamp').length).toBe(10);
    expect(el.querySelector('.lamp.on')).toBeNull();
  });

  it('Start the session plays the start lights over the home page', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('.session-btn') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(el.querySelector('.lights-overlay')).not.toBeNull();
    expect(el.textContent).toContain('Quick race');
  });
});

describe('Tutorial', () => {
  const click = (el: HTMLElement, selector: string, text?: string) => {
    const all = [...el.querySelectorAll<HTMLButtonElement>(selector)];
    const b = text ? all.find((x) => x.textContent?.includes(text)) : all[0];
    expect(b).toBeTruthy();
    b!.click();
  };

  it('spotlights one region per lap and finishes P3 when you cover and attack', async () => {
    const fixture = TestBed.createComponent(Tutorial);
    const el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    const lit = () => [...el.querySelectorAll('.tut-card.lit')].map((x) => x.className);
    expect(lit()).toEqual([]);

    click(el, '.eng-btn', 'Lights out');
    await fixture.whenStable();
    expect(lit()[0]).toContain('tut-tower');

    click(el, '.eng-btn', 'Next lap');
    await fixture.whenStable();
    expect(lit()[0]).toContain('tut-laps');

    click(el, '.eng-btn', 'Next lap');
    await fixture.whenStable();
    expect(lit()[0]).toContain('tut-radio');
    expect(el.querySelector('.eng-btn')).toBeNull(); // must answer the radio first
    click(el, '.tut-opt', 'Box this lap');
    await fixture.whenStable();

    click(el, '.eng-btn', 'Next lap');
    await fixture.whenStable();
    click(el, '.eng-btn', 'Next lap');
    await fixture.whenStable();
    expect(el.querySelector('.tut-ctl.lit [data-ers]')).not.toBeNull();
    click(el, '.tut-ers button', 'Attack');
    await fixture.whenStable();

    click(el, '.eng-btn', 'Take the flag');
    await fixture.whenStable();
    expect(el.querySelector('.tut-pos')?.textContent).toBe('P3');
  });

  it("lap 4 waits for BOX when you didn't cover", async () => {
    const fixture = TestBed.createComponent(Tutorial);
    const el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    for (const t of ['Lights out', 'Next lap', 'Next lap']) {
      click(el, '.eng-btn', t);
      await fixture.whenStable();
    }
    click(el, '.tut-opt', 'Stick to the plan');
    await fixture.whenStable();
    click(el, '.eng-btn', 'Next lap');
    await fixture.whenStable();
    expect(el.querySelector('.eng-btn')).toBeNull();
    expect(el.querySelector('.tut-ctl.lit .tut-box')).not.toBeNull();
    click(el, '.tut-box');
    await fixture.whenStable();
    expect(el.querySelector('.eng-btn')?.textContent).toContain('Next lap');
  });
});
