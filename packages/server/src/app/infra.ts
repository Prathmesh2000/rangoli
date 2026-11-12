/** The two things that differ on AWS: where image bytes go, and how email leaves. */

export interface BlobStore {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  deletePrefix(prefix: string): Promise<void>;
}

export interface S3Options {
  bucket: string;
  region?: string;
  /** only for S3-compatible emulators; AWS itself needs no endpoint */
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export async function s3Blobs(opts: S3Options): Promise<BlobStore> {
  const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1',
    ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' } : {}),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  });
  const Bucket = opts.bucket;
  return {
    put: async (Key, Body, ContentType) => void (await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }))),
    get: async (Key) => {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket, Key }));
        return r.Body ? Buffer.from(await r.Body.transformToByteArray()) : null;
      } catch (e) {
        if ((e as { name?: string }).name === 'NoSuchKey') return null;
        throw e;
      }
    },
    deletePrefix: async (Prefix) => {
      let ContinuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        const Objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (Objects.length) await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
        ContinuationToken = page.NextContinuationToken;
      } while (ContinuationToken);
    },
  };
}

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
}

export interface Mailer {
  /** false when mail goes to the server log, so the app still shows links to copy */
  delivers: boolean;
  send(m: MailMessage): Promise<void>;
}

export async function sesMailer(from: string, region?: string): Promise<Mailer> {
  const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
  const client = new SESv2Client({ region: region ?? process.env.AWS_REGION ?? 'us-east-1' });
  return {
    delivers: true,
    send: async ({ to, subject, text }) => {
      // one message each, so recipients do not see one another's addresses
      for (const address of to) {
        await client.send(new SendEmailCommand({ FromEmailAddress: from, Destination: { ToAddresses: [address] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } } }));
      }
    },
  };
}

/** Without SES a password reset can still be completed by whoever operates the server. */
export const logMailer: Mailer = {
  delivers: false,
  send: async ({ to, subject, text }) => console.error(`[rangoli] mail to ${to.join(', ')}: ${subject}\n${text}`),
};
