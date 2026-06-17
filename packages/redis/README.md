### Local Redis Setup

This script helps in setting up a Redis Cluster locally for development or testing purposes. It automates the process of starting multiple Redis instances and configuring them to form a cluster. It is important to verify any code changes against a redis cluster as this is what our infrastructure consists of and they are not interoperable.

1. `cd ./local`
2. Optionally, modify the settings in the script according to your requirements. Parameters such as the number of nodes, replicas, ports, etc., can be adjusted.
3. Run the script with the `start` argument to launch Redis Cluster instances locally.
   `./redisCluster.sh start`
4. After starting the instances, create the Redis cluster using the `create` argument. Optionally, use the `-f` flag to bypass confirmation prompts.
   `./redisCluster.sh create [-f]`
5. Perform additional actions as needed:

-   Stop the instances `./redisCluster.sh stop`
-   Restart the instances `./redisCluster.sh restart`
-   Watch the instances `./redisCluster.sh watch`
-   Tail redis logs `./redisCluster.sh tail <id>` `./redisCluster.sh tailall`
-   Clean up the instances `./redisCluster.sh clean`
-   Clean up the logs `./redisCluster.sh clean-logs`
