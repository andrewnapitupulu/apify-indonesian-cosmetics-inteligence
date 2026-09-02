FROM apify/actor-node-playwright-chrome:24

COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false \
    && npm list --omit=dev --all || true

COPY --chown=myuser . ./

CMD ./start_xvfb_and_run_cmd.sh && npm run start:prod --silent
