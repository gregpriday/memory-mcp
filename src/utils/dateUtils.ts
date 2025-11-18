/**
 * Convert ISO timestamp to human-readable relative time
 * @param isoTimestamp - ISO 8601 formatted timestamp
 * @returns Human-readable relative time (e.g., "3 days ago")
 */
export function formatRelativeTime(isoTimestamp: string): string {
  const now = new Date();
  const then = new Date(isoTimestamp);

  // Handle invalid timestamps
  if (Number.isNaN(then.getTime())) {
    return 'unknown age';
  }

  const diffMs = now.getTime() - then.getTime();

  // Handle future timestamps (negative diff)
  if (diffMs < 0) {
    return 'just now';
  }
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffYear > 0) {
    return diffYear === 1 ? '1 year ago' : `${diffYear} years ago`;
  }
  if (diffMonth > 0) {
    return diffMonth === 1 ? '1 month ago' : `${diffMonth} months ago`;
  }
  if (diffWeek > 0) {
    return diffWeek === 1 ? '1 week ago' : `${diffWeek} weeks ago`;
  }
  if (diffDay > 0) {
    return diffDay === 1 ? '1 day ago' : `${diffDay} days ago`;
  }
  if (diffHour > 0) {
    return diffHour === 1 ? '1 hour ago' : `${diffHour} hours ago`;
  }
  if (diffMin > 0) {
    return diffMin === 1 ? '1 minute ago' : `${diffMin} minutes ago`;
  }
  return 'just now';
}
