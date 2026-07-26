import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 text-center">
      <h1 className="text-4xl font-bold text-slate-100 mb-2">404 - Page Not Found</h1>
      <p className="text-slate-400 mb-6 max-w-md">
        The requested resource or page could not be found.
      </p>
      <Link
        href="/"
        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors"
      >
        Return Home
      </Link>
    </div>
  );
}
