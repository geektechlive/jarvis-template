let _active = false
let _enabled = false

export function setEphemeralGlobalEnabled(on: boolean): void { _enabled = on }
export function isEphemeralGlobalEnabled(): boolean { return _enabled }
export function setEphemeralMode(on: boolean): void { _active = on }
export function isEphemeralMode(): boolean { return _enabled && _active }
