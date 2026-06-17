#!/bin/bash
set -e

REGION="eu-west-1"
LOCAL_PORT=63790

PS3="Select an account: "
select account in non-prod prod; do
    case "$account" in
        non-prod) default_profile="nonprod"; break;;
        prod)     default_profile="prod"; break;;
        *)        echo "Invalid choice, try again.";;
    esac
done

read -r -p "AWS profile name for $account (default: $default_profile): " profile
profile="${profile:-$default_profile}"

echo "Fetching ElastiCache serverless caches in $REGION (profile: $profile)..."

cache_names=()
cache_endpoints=()
while IFS=$'\t' read -r name endpoint; do
    [ -z "$name" ] && continue
    cache_names+=("$name")
    cache_endpoints+=("$endpoint")
done < <(aws elasticache describe-serverless-caches \
    --region "$REGION" --profile "$profile" \
    --query 'ServerlessCaches[].[ServerlessCacheName,Endpoint.Address]' \
    --output text)

if [ ${#cache_names[@]} -eq 0 ]; then
    echo "No serverless caches found in $REGION for profile $profile."
    exit 1
fi

cache=""
PS3="Select a cache: "
select choice in "${cache_names[@]}"; do
    if [ -n "$choice" ]; then
        cache="${cache_endpoints[$((REPLY-1))]}"
        break
    fi
    echo "Invalid choice, try again."
done

BASTION_HOST_NAME="$account-ssm-host"
echo "---"
BASTION_HOST_INSTANCE_ID=$(aws ec2 describe-instances \
    --filters "Name=tag-value,Values=$BASTION_HOST_NAME" "Name=instance-state-code,Values=16" \
    --region "$REGION" --profile "$profile" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text)

if [ "$BASTION_HOST_INSTANCE_ID" = "None" ] || [ -z "$BASTION_HOST_INSTANCE_ID" ]; then
    echo "Could not find a running bastion host tagged $BASTION_HOST_NAME."
    exit 1
fi

echo "Found bastion $BASTION_HOST_INSTANCE_ID. Opening tunnel localhost:$LOCAL_PORT -> $cache:6379 (Ctrl+C to stop)."

aws ssm start-session --target "$BASTION_HOST_INSTANCE_ID" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"portNumber\":[\"6379\"],\"localPortNumber\":[\"$LOCAL_PORT\"],\"host\":[\"$cache\"]}" \
    --region "$REGION" --profile "$profile"
