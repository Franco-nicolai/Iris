export function IrisOrbVisual({ className = '' }: { className?: string }) {
  return <div className={`iris-orb-visual ${className}`} aria-hidden="true">
    <div className="orb-halo halo-one" />
    <div className="orb-halo halo-two" />
    <div className="orb-core"><div className="orb-shine" /><div className="orb-inner" /></div>
  </div>
}
