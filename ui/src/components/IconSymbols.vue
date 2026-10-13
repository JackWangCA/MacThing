<template>
    <svg width="0" height="0" style="position: absolute">
      <!-- UI glyphs (24×24, currentColor) -->
      <symbol id="i-play" viewBox="0 0 24 24">
        <path
          d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"
        />
      </symbol>
      <symbol id="i-pause" viewBox="0 0 24 24">
        <rect x="5" y="4" width="5" height="16" rx="1.2" />
        <rect x="14" y="4" width="5" height="16" rx="1.2" />
      </symbol>
      <symbol id="i-next" viewBox="0 0 24 24">
        <path
          d="M3 6.2v11.6a.8.8 0 0 0 1.25.66L12 13.2v4.6a.8.8 0 0 0 1.25.66l8.4-5.8a.8.8 0 0 0 0-1.32l-8.4-5.8A.8.8 0 0 0 12 6.2v4.6L4.25 5.54A.8.8 0 0 0 3 6.2z"
        />
      </symbol>
      <symbol id="i-previous" viewBox="0 0 24 24">
        <path
          d="M21 6.2v11.6a.8.8 0 0 1-1.25.66L12 13.2v4.6a.8.8 0 0 1-1.25.66l-8.4-5.8a.8.8 0 0 1 0-1.32l8.4-5.8A.8.8 0 0 1 12 6.2v4.6l7.75-5.26A.8.8 0 0 1 21 6.2z"
        />
      </symbol>
      <symbol id="i-heart" viewBox="0 0 24 24">
        <path
          d="M12 20.4s-7.4-4.4-9.2-9.1C1.6 8 3.6 4.6 7 4.6c2 0 3.6 1.1 5 2.9 1.4-1.8 3-2.9 5-2.9 3.4 0 5.4 3.4 4.2 6.7-1.8 4.7-9.2 9.1-9.2 9.1z"
        />
      </symbol>
      <symbol id="i-heart-off" viewBox="0 0 24 24">
        <path
          d="M12 20.4s-7.4-4.4-9.2-9.1C1.6 8 3.6 4.6 7 4.6c2 0 3.6 1.1 5 2.9 1.4-1.8 3-2.9 5-2.9 3.4 0 5.4 3.4 4.2 6.7-1.8 4.7-9.2 9.1-9.2 9.1z"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linejoin="round"
        />
      </symbol>
      <symbol id="i-note" viewBox="0 0 24 24">
        <path d="M9 7.2a1 1 0 0 1 .78-.98l10-2.2A1 1 0 0 1 21 5v11a3 3 0 1 1-2-2.83V8.25l-8 1.76V18a3 3 0 1 1-2-2.83z" />
      </symbol>
      <symbol id="i-timer" viewBox="0 0 24 24">
        <path fill-rule="evenodd" d="M9 1.5h6a1 1 0 0 1 0 2h-2v1.56A8.5 8.5 0 1 1 11 5.06V3.5H9a1 1 0 0 1 0-2zM12 7a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13z" />
        <path d="M12 8.5v5h5a5 5 0 0 0-5-5z" />
      </symbol>
      <symbol id="i-speaker" viewBox="0 0 24 24">
        <path d="M4 9h3.5L12 5v14l-4.5-4H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" />
        <path
          d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </symbol>
      <symbol id="i-muted" viewBox="0 0 24 24">
        <path d="M4 9h3.5L12 5v14l-4.5-4H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" />
        <path
          d="M16 9.5l5 5M21 9.5l-5 5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </symbol>
      <!-- Opens on the Mac: an arrow out of a bracket (after Font Awesome's arrow-right-from-bracket). -->
      <symbol id="i-open-on-mac" viewBox="0 0 24 24">
        <g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
          <path d="M10 12h10M15.5 7.5 20 12l-4.5 4.5" />
        </g>
      </symbol>

      <!-- Weather icons (64×64, full colour) -->
      <symbol id="w-cloud-shape" viewBox="0 0 64 64">
        <circle cx="24" cy="40" r="10" />
        <circle cx="36" cy="33" r="13" />
        <circle cx="47" cy="41" r="9" />
        <rect x="24" y="40" width="23" height="10" />
      </symbol>
      <symbol id="w-sun-shape" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="12" style="fill: var(--sun)" />
        <g style="stroke: var(--sun)" stroke-width="4" stroke-linecap="round">
          <path
            d="M32 6v6M32 52v6M6 32h6M52 32h6M13.6 13.6l4.2 4.2M46.2 46.2l4.2 4.2M13.6 50.4l4.2-4.2M46.2 17.8l4.2-4.2"
          />
        </g>
      </symbol>
      <symbol id="w-moon-shape" viewBox="0 0 64 64">
        <path
          d="M40 10a22 22 0 1 0 14 34A18 18 0 0 1 40 10z"
          style="fill: var(--moon)"
        />
      </symbol>
      <symbol id="w-clear-day" viewBox="0 0 64 64">
        <use href="#w-sun-shape" />
      </symbol>
      <symbol id="w-clear-night" viewBox="0 0 64 64">
        <use href="#w-moon-shape" />
      </symbol>
      <symbol id="w-partly-day" viewBox="0 0 64 64">
        <use href="#w-sun-shape" x="-9" y="-9" width="58" height="58" />
        <use href="#w-cloud-shape" y="4" style="fill: var(--cloud)" />
      </symbol>
      <symbol id="w-partly-night" viewBox="0 0 64 64">
        <use href="#w-moon-shape" x="-8" y="-8" width="52" height="52" />
        <use href="#w-cloud-shape" y="4" style="fill: var(--cloud)" />
      </symbol>
      <symbol id="w-cloudy" viewBox="0 0 64 64">
        <use
          href="#w-cloud-shape"
          x="-8"
          y="-9"
          style="fill: var(--cloud-back)"
        />
        <use href="#w-cloud-shape" x="4" y="2" style="fill: var(--cloud)" />
      </symbol>
      <symbol id="w-fog" viewBox="0 0 64 64">
        <use href="#w-cloud-shape" y="-10" style="fill: var(--cloud-back)" />
        <g style="stroke: var(--cloud)" stroke-width="4" stroke-linecap="round">
          <path d="M14 48h36M20 56h26" />
        </g>
      </symbol>
      <symbol id="w-drizzle" viewBox="0 0 64 64">
        <use href="#w-cloud-shape" y="-10" style="fill: var(--cloud)" />
        <g style="stroke: var(--rain)" stroke-width="4" stroke-linecap="round">
          <path d="M24 48v4M34 50v4M44 48v4" />
        </g>
      </symbol>
      <symbol id="w-rain" viewBox="0 0 64 64">
        <use href="#w-cloud-shape" y="-10" style="fill: var(--cloud)" />
        <g style="stroke: var(--rain)" stroke-width="4" stroke-linecap="round">
          <path d="M25 46l-3 10M35 46l-3 10M45 46l-3 10" />
        </g>
      </symbol>
      <symbol id="w-snow" viewBox="0 0 64 64">
        <use href="#w-cloud-shape" y="-10" style="fill: var(--cloud)" />
        <g style="fill: var(--cloud-back)">
          <circle cx="24" cy="50" r="3" />
          <circle cx="34" cy="55" r="3" />
          <circle cx="44" cy="50" r="3" />
        </g>
      </symbol>
      <symbol id="w-thunder" viewBox="0 0 64 64">
        <use href="#w-cloud-shape" y="-10" style="fill: var(--cloud-back)" />
        <path d="M35 40l-9 12h7l-4 10 11-14h-7l4-8z" style="fill: var(--sun)" />
      </symbol>
    </svg>

</template>
