# Deploying Rangoli on AWS

```
Browser ──HTTPS──▶ ALB ──▶ ECS Fargate (1 task) ──▶ RDS PostgreSQL 17   accounts, projects, designs, permissions
                                   │
                                   ├──▶ S3      image files
                                   └──▶ SES     invites, review requests, password resets
```

The stack in [rangoli.yaml](rangoli.yaml) creates the network, database, bucket, secrets, load balancer and service. RDS sits in subnets with no route to the internet. The app logs in as `rangoli_login`, which cannot bypass row-level security; the RDS master password is used only for migrations at startup.

## Before you start

- An ACM certificate for your domain, in the deployment region.
- For email, a verified SES sender. New SES accounts are in the sandbox and can only mail verified addresses until you request production access. Without a sender the app still works: admins copy invite links, and password-reset links go to the task logs.

## Deploy

```bash
REGION=us-east-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
IMAGE=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/rangoli:v1

aws ecr create-repository --repository-name rangoli --region $REGION
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker build --platform linux/amd64 -t $IMAGE .
docker push $IMAGE

aws cloudformation deploy --region $REGION --stack-name rangoli \
  --template-file deploy/aws/rangoli.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides ImageUri=$IMAGE DomainName=design.example.com \
    CertificateArn=arn:aws:acm:... SesFromAddress=rangoli@example.com
```

Point your DNS at the `LoadBalancerDns` stack output, open the site, and create the first account. With `InviteOnly=1` (the default), every account after that needs an invite, so create yours first.

To ship a new version, push a new image tag and run the same `deploy` command with the new `ImageUri`.

## Things to know

- **One task, by design.** Open designs are held in the app process, and a Postgres lock stops a second task from writing. Scale up with `TaskCpu` and `TaskMemory`, not task count.
- **Deploys cause a short outage,** about a minute, because the old task has to stop before the new one takes the lock. If a task dies, ECS replaces it and saved work is intact; edits from the last fraction of a second may be lost.
- **Backups.** RDS keeps 14 days of snapshots. S3 keeps deleted image versions for 30 days. Deleting the stack leaves a final database snapshot and the bucket behind.
- **Cost.** With the defaults (Multi-AZ `db.t4g.small`, 1 vCPU task, one ALB), budget roughly $100–130 a month before traffic. Check current AWS pricing for your region.
