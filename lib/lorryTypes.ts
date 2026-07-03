// The kinds of vehicle production can ask for / tag a lorry as. 'any' is only for
// a request ("send whatever"); the rest describe an actual vehicle. Add new
// vehicle types here — both the Delivery Orders request form and the Lorry
// Internal Transfer parking panel read from this one list.
export const LORRY_TYPES: { value: string; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'small', label: 'Small lorry' },
  { value: 'big', label: 'Big lorry' },
  { value: 'van', label: 'Van' },
  { value: 'reach', label: 'Reach truck' },
]

// Options for tagging a real vehicle's type (everything except the request-only 'any').
export const VEHICLE_TYPES = LORRY_TYPES.filter(t => t.value !== 'any')

export const lorryTypeLabel = (v: string | null | undefined) =>
  LORRY_TYPES.find(t => t.value === v)?.label || v || ''
