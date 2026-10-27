export class Command {
  capability: string;
  command: string;
  arguments?: unknown[];
  component?: string;

  constructor(capability: string, command: string, args?: unknown[], component?: string) {
    this.capability = capability;
    this.command = command;
    this.arguments = args;
    this.component = component;
  }
}
