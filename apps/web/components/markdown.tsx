import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  // 表格只在自己的框裡橫向捲動，不撐寬版面。
  // 一定要把 node 從 props 拿掉，否則 React 會對 <table> 警告未知屬性。
  table: ({ node, ...props }) => {
    void node;
    return <div className="my-3 overflow-x-auto"><table className="my-0" {...props} /></div>;
  },
};

export function Markdown({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div className={[
      'prose max-w-none break-words',
      'prose-headings:font-display prose-headings:text-ink prose-headings:font-bold',
      'prose-h1:text-xl prose-h2:text-xl prose-h3:text-base prose-h4:text-base',
      'prose-a:text-link prose-strong:text-ink prose-th:text-sm prose-td:text-sm prose-pre:text-sm',
      compact
        ? 'prose-sm prose-p:my-2 prose-li:my-0.5 prose-headings:mt-4 prose-headings:mb-1 prose-hr:my-3'
        : 'prose-p:my-3 prose-li:my-1 prose-headings:mt-6 prose-headings:mb-2 prose-hr:my-5',
    ].join(' ')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
}
