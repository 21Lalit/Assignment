import type { SVGProps } from 'react';

export type IconName =
  | 'activity'
  | 'agents'
  | 'answer'
  | 'arrow-down'
  | 'arrow-up'
  | 'calls'
  | 'check'
  | 'chevron-right'
  | 'clock'
  | 'cloud'
  | 'code'
  | 'database'
  | 'info'
  | 'latency'
  | 'pause'
  | 'play'
  | 'reset'
  | 'route'
  | 'shield'
  | 'spark'
  | 'step'
  | 'target'
  | 'warning'
  | 'zap';

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    ...props,
  };

  switch (name) {
    case 'activity':
      return <svg {...common}><path d="M3 12h4l2.2-6 4.1 12 2.1-6H21" /></svg>;
    case 'agents':
      return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></svg>;
    case 'answer':
      return <svg {...common}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" /></svg>;
    case 'arrow-down':
      return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
    case 'arrow-up':
      return <svg {...common}><path d="m18 15-6-6-6 6" /></svg>;
    case 'calls':
      return <svg {...common}><path d="M5 4h4l2 5-2.5 1.5a13 13 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2C9.7 20.5 3.5 14.3 3 6a2 2 0 0 1 2-2Z" /></svg>;
    case 'check':
      return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case 'chevron-right':
      return <svg {...common}><path d="m9 18 6-6-6-6" /></svg>;
    case 'clock':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case 'cloud':
      return <svg {...common}><path d="M17.5 19H7a5 5 0 1 1 1-9.9A6 6 0 0 1 19.6 11 4 4 0 0 1 17.5 19Z" /></svg>;
    case 'code':
      return <svg {...common}><path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14" /></svg>;
    case 'database':
      return <svg {...common}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></svg>;
    case 'info':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
    case 'latency':
      return <svg {...common}><path d="M4 14a8 8 0 1 1 16 0" /><path d="m12 14 4-4M5 19h14" /></svg>;
    case 'pause':
      return <svg {...common}><path d="M9 6v12M15 6v12" /></svg>;
    case 'play':
      return <svg {...common}><path d="m8 5 11 7-11 7Z" /></svg>;
    case 'reset':
      return <svg {...common}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>;
    case 'route':
      return <svg {...common}><circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M8 18h2a2 2 0 0 0 2-2V8a2 2 0 0 1 2-2h2" /></svg>;
    case 'shield':
      return <svg {...common}><path d="M12 3 4.5 6v5.5c0 4.7 3.2 8 7.5 9.5 4.3-1.5 7.5-4.8 7.5-9.5V6Z" /><path d="m8.5 12 2.2 2.2 4.7-5" /></svg>;
    case 'spark':
      return <svg {...common}><path d="m12 2 1.3 5.2L18 10l-4.7 2.8L12 18l-1.3-5.2L6 10l4.7-2.8ZM19 17l.6 2.4L22 20l-2.4.6L19 23l-.6-2.4L16 20l2.4-.6Z" /></svg>;
    case 'step':
      return <svg {...common}><path d="m6 5 9 7-9 7ZM18 5v14" /></svg>;
    case 'target':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></svg>;
    case 'warning':
      return <svg {...common}><path d="M10.3 4.3 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>;
    case 'zap':
      return <svg {...common}><path d="M13 2 4 14h7l-1 8 9-12h-7Z" /></svg>;
  }
}

export function BrandLoop({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="46"
      height="34"
      viewBox="0 0 46 34"
      fill="none"
      role="img"
      aria-label="CredResolve"
    >
      <path
        d="M19.2 10.1C15.7 4.9 8 4 3.7 8.2-.8 12.6 2.3 20 8.5 20h5.2"
        stroke="currentColor"
        strokeWidth="5.2"
        strokeLinecap="round"
      />
      <path
        d="M26.8 23.9c3.5 5.2 11.2 6.1 15.5 1.9 4.5-4.4 1.4-11.8-4.8-11.8h-5.2"
        stroke="#FCAF17"
        strokeWidth="5.2"
        strokeLinecap="round"
      />
      <path d="m15 20 16-12" stroke="currentColor" strokeWidth="5.2" strokeLinecap="round" />
    </svg>
  );
}
