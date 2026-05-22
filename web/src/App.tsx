import './App.css';

/**
 * The stages a post moves through in the review pipeline. The dashboard
 * renders one column per stage; posts are slotted into a column by their
 * `status` attribute in DynamoDB.
 */
export const PIPELINE_STAGES = [
  { id: 'queued', label: 'Queued' },
  { id: 'reviewing', label: 'In review' },
  { id: 'staged', label: 'In the bag' },
  { id: 'published', label: 'Published' },
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGES)[number]['id'];

export default function App() {
  return (
    <main className="app">
      <header className="app__header">
        <h1>Blog Pipeline</h1>
        <p>Cloud-native review pipeline for blog.nakom.is content.</p>
      </header>
      <section className="stages" aria-label="Pipeline stages">
        {PIPELINE_STAGES.map((stage) => (
          <article key={stage.id} className="stage" data-stage={stage.id}>
            <h2>{stage.label}</h2>
            <p className="stage__empty">No posts yet</p>
          </article>
        ))}
      </section>
    </main>
  );
}
