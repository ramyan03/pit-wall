import { Component } from '@angular/core';
import { TRACK_SCHEMA_VERSION } from '@pit-wall/engine';

@Component({
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly schemaVersion = TRACK_SCHEMA_VERSION;
}
