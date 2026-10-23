  var CODES = {
    0: ['clear', 'Clear', 'Sunny'], 1: ['partly', 'Mostly clear', 'Mostly sunny'], 2: ['partly', 'Partly cloudy'],
    3: ['cloudy', 'Cloudy'], 45: ['fog', 'Fog'], 48: ['fog', 'Freezing fog'],
    51: ['drizzle', 'Light drizzle'], 53: ['drizzle', 'Drizzle'], 55: ['drizzle', 'Heavy drizzle'],
    56: ['drizzle', 'Freezing drizzle'], 57: ['drizzle', 'Freezing drizzle'],
    61: ['rain', 'Light rain'], 63: ['rain', 'Rain'], 65: ['rain', 'Heavy rain'], 66: ['rain', 'Freezing rain'], 67: ['rain', 'Freezing rain'],
    71: ['snow', 'Light snow'], 73: ['snow', 'Snow'], 75: ['snow', 'Heavy snow'], 77: ['snow', 'Snow grains'],
    80: ['rain', 'Showers'], 81: ['rain', 'Showers'], 82: ['rain', 'Heavy showers'], 85: ['snow', 'Snow showers'], 86: ['snow', 'Snow showers'],
    95: ['thunder', 'Thunderstorms'], 96: ['thunder', 'Thunderstorms'], 99: ['thunder', 'Thunderstorms']
  };
  /** Rain, drizzle, snow or thunder: weather worth a heads-up. */
  export function isWet(code) {
    var kind = (CODES[code] || [''])[0];
    return kind === 'rain' || kind === 'drizzle' || kind === 'snow' || kind === 'thunder';
  }
  export function describe(code, isDay) {
    var c = CODES[code] || ['cloudy', 'Cloudy'];
    var kind = c[0];
    var dayNight = kind === 'clear' || kind === 'partly' ? kind + '-' + (isDay ? 'day' : 'night') : null;
    return { icon: '#w-' + (dayNight || kind), label: (isDay && c[2]) || c[1] };
  }
