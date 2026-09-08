export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  constructor(private t: Date) {}

  now(): Date {
    return this.t;
  }

  advanceTo(t: Date): void {
    this.t = t;
  }
}
