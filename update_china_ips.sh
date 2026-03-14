#!/bin/bash
# 下载中国大陆 IP 段列表并生成 Caddy 配置片段

set -e

CHINA_IP_URL="https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt"
OUTPUT_FILE="china_ips.caddy"

echo "Downloading China IP list..."
curl -s $CHINA_IP_URL > raw_ips.txt

echo "Generating Caddy configuration..."
echo "remote_ip {" > $OUTPUT_FILE
while read -r ip; do
  echo "  $ip" >> $OUTPUT_FILE
done < raw_ips.txt
echo "}" >> $OUTPUT_FILE

rm raw_ips.txt
echo "Done! Generated $OUTPUT_FILE."
