/** Countries offered in address forms (ISO 3166-1 alpha-2 code, display name). */
export const COUNTRIES: [string, string][] = [
  ["US", "United States"],
  ["GB", "United Kingdom"],
  ["CA", "Canada"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["IT", "Italy"],
  ["ES", "Spain"],
  ["CH", "Switzerland"],
  ["AE", "United Arab Emirates"],
  ["JP", "Japan"],
  ["AM", "Armenia"],
];

export const countryName = (code: string) => COUNTRIES.find(([c]) => c === code)?.[1] ?? code;
