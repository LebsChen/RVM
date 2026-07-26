import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST(req: Request) {
  try {
    const { command, cwd } = await req.json();
    if (!command || typeof command !== 'string') {
      return NextResponse.json({ error: 'Command is required' }, { status: 400 });
    }

    const targetCwd = cwd || process.cwd();
    const { stdout, stderr } = await execAsync(command, { cwd: targetCwd, timeout: 30000 });

    return NextResponse.json({
      stdout,
      stderr,
      command,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        error: error.message || 'Execution failed',
        stdout: error.stdout || '',
        stderr: error.stderr || '',
      },
      { status: 500 }
    );
  }
}
