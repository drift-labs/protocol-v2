#!/bin/bash

count=0
trap 'echo -e "\nStopped after $count runs"; exit 0' INT

while true; do
  if ! bash test-scripts/single-anchor-test.sh --skip-build; then
    echo "Test failed after $count successful runs!"
    exit 1
  fi
  count=$((count + 1))
  echo "Test passed ($count), running again..."
done
