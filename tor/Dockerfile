# Self-contained Tor sidecar for SuperStress (no mounts, no command needed).
# Same pattern as sirjamzalot/superbrain-tor but with a torrc tuned for
# monerod P2P sync over Tor (see torrc comments).
FROM alpine:3.20
RUN apk add --no-cache tor
COPY torrc /etc/tor/torrc
RUN mkdir -p /var/lib/tor && chown -R tor:tor /var/lib/tor
USER tor
ENTRYPOINT ["tor", "-f", "/etc/tor/torrc"]
