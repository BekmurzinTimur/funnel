import type { AnalyticsResponse } from '@shared/api';
import { ChartFrame, SeriesBars, type BarDatum } from '../charts';
import { count } from '../format';
import { EmptyNotice, SectionCard } from '../parts';

/** Distinct sessions per event name. One series, so no legend and no second hue. */
export default function EventsTab({ data }: { data: AnalyticsResponse }) {
  if (data.eventCounts.length === 0) {
    return <EmptyNotice>No events match these filters.</EmptyNotice>;
  }

  const peak = Math.max(...data.eventCounts.map((e) => e.sessions), 1);
  const bars: BarDatum[] = data.eventCounts.map((e) => ({
    id: e.name,
    label: e.name,
    rate: e.sessions / peak,
    valueLabel: count(e.sessions),
    slot: 1,
  }));

  return (
    <SectionCard
      title={`Events · v${data.filters.version}`}
      subtitle="Distinct sessions per event name for the current filters. New event types appear here with no code change."
    >
      <ChartFrame caption="Sessions per event">
        <SeriesBars data={bars} />
      </ChartFrame>
    </SectionCard>
  );
}
