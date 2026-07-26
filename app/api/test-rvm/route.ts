import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
import { spawn } from 'child_process';
import path from 'path';

export async function POST(): Promise<Response> {
  return new Promise<Response>((resolve) => {
    const testScriptPath = path.join(process.cwd(), 'rvm', 'agent', 'test.js');
    
    let output = '';
    let errorOutput = '';

    const child = spawn('node', [testScriptPath], {
      env: {
        ...process.env,
        TEST_PORT: '9898',
        TEST_TOKEN: 'devin-docker-test-token-2026',
      },
    });

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    child.on('close', (code) => {
      resolve(
        NextResponse.json({
          success: code === 0,
          exitCode: code,
          output,
          errorOutput,
          timestamp: new Date().toISOString(),
        })
      );
    });

    child.on('error', (err) => {
      resolve(
        NextResponse.json(
          {
            success: false,
            exitCode: -1,
            output,
            errorOutput: err.message,
            timestamp: new Date().toISOString(),
          },
          { status: 500 }
        )
      );
    });
  });
}
