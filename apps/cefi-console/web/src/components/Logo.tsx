// The True Markets "T" logomark. It takes the text colour, so it follows the theme.
export function Logo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 984 1000" width={size * 0.984} height={size} className={className} role="img" aria-label="True Markets">
      <path
        fill="currentColor"
        d="M206.8069,0H21.9195C9.9116,0,0,10.0067,0,21.9195v184.8874c0,11.9128,9.7685,21.9195,21.9195,21.9195h184.8874c12.0079,0,21.9195-10.0067,21.9195-21.9195V21.9195C228.7264,10.0067,218.9579,0,206.8069,0z M962.5569,0.4764H569.9098c-108.8831,0-196.7999,88.155-196.7999,196.8002v780.8038c0,11.9128,9.8639,21.9195,21.9198,21.9195h193.9884c12.151,0,21.9197-10.0067,21.9197-21.9195l-0.0477-765.0789h351.1904c12.151,0,21.9195-10.007,21.9195-21.9198V21.9195C984,10.0067,974.4697,0,962.5569,0.4764z"
      />
    </svg>
  );
}
