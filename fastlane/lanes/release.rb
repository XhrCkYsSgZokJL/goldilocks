platform :ios do
  desc "Build Convos (Dev) and upload to TestFlight internal groups"
  lane :testflight_dev do
    setup_ci if is_ci
    setup_app_store_connect_api_key

    # Self-healing CFBundleVersion: prefer git's monotonic commit count, but
    # always overshoot the highest build currently in TestFlight so re-runs
    # and out-of-order pushes never collide with ASC's "must be greater" rule.
    git_count = `git rev-list --count HEAD`.strip.to_i
    latest_tf = latest_testflight_build_number(
      app_identifier: DEV_BUNDLE_ID,
      initial_build_number: 0,
    )
    build_number = [git_count, latest_tf + 1].max
    UI.message("Build number: git=#{git_count}, latest_tf=#{latest_tf}, using=#{build_number}")

    increment_build_number(
      build_number: build_number,
      xcodeproj: PROJECT,
    )

    match(
      type: "appstore",
      git_url: MATCH_GIT_URL,
      app_identifier: [DEV_BUNDLE_ID, DEV_NSE_BUNDLE_ID, DEV_CLIP_BUNDLE_ID],
      readonly: is_ci,
    )

    build_app(
      project: PROJECT,
      scheme: DEV_SCHEME,
      configuration: DEV_CONFIG,
      export_method: "app-store",
      output_directory: OUTPUT_DIR,
      output_name: "Convos-Dev-TestFlight.ipa",
      clean: true,
      export_options: {
        provisioningProfiles: {
          DEV_BUNDLE_ID      => "match AppStore #{DEV_BUNDLE_ID}",
          DEV_NSE_BUNDLE_ID  => "match AppStore #{DEV_NSE_BUNDLE_ID}",
          DEV_CLIP_BUNDLE_ID => "match AppStore #{DEV_CLIP_BUNDLE_ID}",
        },
      },
    )

    upload_to_testflight(
      ipa: File.join(OUTPUT_DIR, "Convos-Dev-TestFlight.ipa"),
      app_identifier: DEV_BUNDLE_ID,
      groups: ["Convos Team - Auto", "Convos iOS Team - Auto"],
      changelog: testflight_release_notes,
      distribute_external: false,
      skip_waiting_for_build_processing: false,
      notify_external_testers: false,
    )

    upload_sentry_dsyms_if_configured
  end

  # Push dSYMs to Sentry so production-style Dev crash reports symbolicate
  # cleanly. Skipped when env config is missing so local runs without a
  # Sentry token still succeed.
  def upload_sentry_dsyms_if_configured
    auth_token   = ENV["SENTRY_AUTH_TOKEN"]
    org_slug     = ENV["SENTRY_ORG_SLUG"]
    project_slug = ENV["SENTRY_PROJECT_SLUG"]

    if auth_token.to_s.empty? || org_slug.to_s.empty? || project_slug.to_s.empty?
      UI.important("Skipping Sentry dSYM upload (SENTRY_AUTH_TOKEN, SENTRY_ORG_SLUG, or SENTRY_PROJECT_SLUG not set).")
      return
    end

    sentry_debug_files_upload(
      auth_token:   auth_token,
      org_slug:     org_slug,
      project_slug: project_slug,
      path:         lane_context[SharedValues::DSYM_OUTPUT_PATH],
    )
  end

  # Release notes shown to internal testers in TestFlight. Includes commit
  # subject + short SHA + branch so a tester can map a build back to the
  # exact commit that produced it.
  def testflight_release_notes
    sha     = (ENV["GITHUB_SHA"] || `git rev-parse HEAD`.strip).slice(0, 7)
    subject = `git log -1 --pretty=%s`.strip
    branch  = ENV["GITHUB_REF_NAME"] || `git rev-parse --abbrev-ref HEAD`.strip
    "#{subject}\nBranch: #{branch}\nCommit: #{sha}"
  end
end
