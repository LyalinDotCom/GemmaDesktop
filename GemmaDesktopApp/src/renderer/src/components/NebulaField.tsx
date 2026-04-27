import { memo } from 'react'

interface NebulaFieldProps {
  variant: 'vivid' | 'ambient'
  busy?: boolean
}

const SLOW_PATHS = [
  'M132 322 C226 116 382 210 486 276 C594 346 640 148 760 238 C884 330 934 496 1086 278',
  'M104 524 C248 374 360 592 488 484 C612 382 698 174 836 310 C918 390 934 492 1060 438',
  'M214 176 C336 284 426 84 550 174 C664 258 754 144 858 244 C930 314 982 248 1032 180',
  'M210 640 C340 482 494 716 656 568 C780 456 840 386 950 500 C1018 570 1056 590 1104 614',
  'M386 92 C306 234 548 292 520 438 C488 596 444 642 620 704',
  'M792 82 C660 214 840 316 758 424 C658 556 760 636 910 706',
] as const

const FAST_PATHS = [
  'M268 390 C380 258 532 316 612 382 C710 462 792 488 944 350',
  'M322 466 C444 344 528 538 642 448 C748 364 796 302 924 464',
  'M452 256 C528 172 606 218 674 282 C748 352 804 386 892 286',
] as const

const NODE_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [156, 316], [602, 316], [1052, 294], [110, 512], [520, 454],
  [1034, 428], [230, 178], [640, 194], [1018, 184], [224, 642],
  [716, 556], [1094, 616], [378, 96], [514, 474], [610, 704],
  [786, 86], [746, 436], [900, 706],
]

export const NebulaField = memo(function NebulaField({ variant, busy = false }: NebulaFieldProps) {
  const wrapperClass = `nebula-field nebula-field-${variant}${busy ? ' nebula-field-busy' : ''}`
  const idPrefix = `nebulaField-${variant}`
  const strokeAId = `${idPrefix}-strokeA`
  const strokeBId = `${idPrefix}-strokeB`
  const glowId = `${idPrefix}-glow`

  return (
    <div aria-hidden="true" className={wrapperClass}>
      <svg
        className="nebula-field-network"
        viewBox="0 0 1200 760"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <linearGradient id={strokeAId} x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#67e8f9" />
            <stop offset="52%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#f472b6" />
          </linearGradient>
          <linearGradient id={strokeBId} x1="100%" x2="0%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#34d399" />
            <stop offset="50%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#fb7185" />
          </linearGradient>
          <filter id={glowId} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g className="nebula-field-network-slow" fill="none" filter={`url(#${glowId})`}>
          {SLOW_PATHS.map((d, index) => (
            <path
              key={d}
              d={d}
              stroke={index % 2 === 0 ? `url(#${strokeAId})` : `url(#${strokeBId})`}
            />
          ))}
        </g>
        <g className="nebula-field-network-fast" fill="none" filter={`url(#${glowId})`}>
          {FAST_PATHS.map((d, index) => (
            <path
              key={d}
              d={d}
              stroke={index % 2 === 0 ? `url(#${strokeAId})` : `url(#${strokeBId})`}
            />
          ))}
        </g>
        <g className="nebula-field-nodes" filter={`url(#${glowId})`}>
          {NODE_POSITIONS.map(([cx, cy], index) => (
            <circle
              key={`${cx}-${cy}`}
              cx={cx}
              cy={cy}
              r={index % 3 === 0 ? 3.6 : 2.6}
            />
          ))}
        </g>
      </svg>
    </div>
  )
})
