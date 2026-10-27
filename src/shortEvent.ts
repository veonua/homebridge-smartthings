export interface ShortEvent {
  deviceId: string;
  value: any;
  componentId: string;
  capability: string;
  attribute: string;
  eventId?: string;
  eventTime?: number;
  unit?: string;
  data?: unknown;
}
