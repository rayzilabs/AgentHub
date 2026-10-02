import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none prose-headings:font-display prose-headings:text-ink prose-a:text-brand">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
