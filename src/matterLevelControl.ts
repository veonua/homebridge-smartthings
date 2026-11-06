import type { MatterAPI } from 'homebridge';
import type { Behavior, MutableEndpoint } from '@matter/node' with { 'resolution-mode': 'import' };

type DimmableLight = MatterAPI['deviceTypes']['DimmableLight'];
type LevelControl = DimmableLight['behaviors']['levelControl'];
export type WriteStep = (delta: number, withOnOff: boolean, minLevel: number) => Promise<void>;

/** Use the Behavior class from the Matter.js runtime already loaded by Homebridge. */
function behaviorClass(derived: Behavior.Type): typeof Behavior {
  let base = derived;
  while (Object.getPrototypeOf(base) !== Function.prototype) {
    base = Object.getPrototypeOf(base) as Behavior.Type;
  }
  return base as unknown as typeof Behavior;
}

export function withSmartThingsLevelControl(type: MutableEndpoint,
  writeLevel: (level: number, transitionTime: number | null) => Promise<void>,
  writeStep: WriteStep): MutableEndpoint {
  const LevelControlServer = type.behaviors.levelControl as LevelControl;
  const LocalBehavior = behaviorClass(LevelControlServer);

  // This local behavior connects the cluster to the physical device. It also
  // tells Homebridge's cache reconciliation that the restored stock endpoint
  // needs to be re-composed with our command behavior before use.
  class SmartThingsBrightness extends LocalBehavior {
    static override readonly id = 'smartThingsBrightness';

    write(level: number, transitionTime: number | null): Promise<void> {
      return writeLevel(level, transitionTime);
    }

    step(delta: number, withOnOff: boolean, minLevel: number): Promise<void> {
      return writeStep(delta, withOnOff, minLevel);
    }
  }

  class SmartThingsLevelControl extends LevelControlServer {
    private get switchIsOn(): boolean {
      // Restored endpoints may use Homebridge's wrapped OnOff behavior.
      return this.endpoint.stateOf('onOff').onOff === true;
    }

    override async moveToLevelLogic(level: number, transitionTime: number | null, withOnOff: boolean, options = {}): Promise<void> {
      const target = Math.max(this.minLevel, Math.min(this.maxLevel, level));
      const effectiveTime = transitionTime ?? this.state.onOffTransitionTime ?? null;
      if (withOnOff || this.switchIsOn) {
        await this.agent.get(SmartThingsBrightness).write(withOnOff && target === this.minLevel ? 0 : target, effectiveTime);
      }
      // Matter.js 0.17 couples OnOff synchronously. Acquire both clusters
      // asynchronously if a SmartThings report is still being applied.
      if (withOnOff && !('lock' in this.context.transaction)) {
        const onOff = this.endpoint.behaviors.supported.onOff;
        await this.context.transaction.addResources(this, this.agent.get(onOff));
        await this.context.transaction.begin();
      }
      // The physical device reports its actual level; retain Matter's transition model.
      await super.moveToLevelLogic(target, effectiveTime, withOnOff, options);
    }

    override stepLogic(mode: number, size: number, _transitionTime: number | null, withOnOff: boolean): Promise<void> {
      // SmartThings reports the resulting level and switch state.
      return this.agent.get(SmartThingsBrightness).step(mode === 0 ? size : -size, withOnOff, this.minLevel);
    }

    override moveLogic(): never {
      throw new Error('SmartThings does not support continuous Matter level movement');
    }
  }

  return type.with(SmartThingsBrightness, SmartThingsLevelControl);
}
