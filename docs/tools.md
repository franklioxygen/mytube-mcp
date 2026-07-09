# Tool catalog

The catalog is capability-gated at startup. API-key mode has five tools because MyTube v1.10.11’s route table allows only the following API-key paths: `/api/download`, `/api/videos`, `/api/videos/:id`, `/api/collections`, and `/api/system/version`.

## API-key mode

| Tool | Behavior | Annotations |
| --- | --- | --- |
| `download_video` | Enqueue a URL; optionally poll completion | idempotent, open-world |
| `list_videos` | List/paginate/filter library summaries | read-only |
| `get_video` | Read full video metadata | read-only |
| `list_collections` | Read collections and memberships | read-only |
| `get_system_version` | Read installed/latest version | read-only, open-world |

## Admin-session additions

`search_videos`, `check_video_downloaded`, `inspect_url`, `get_download_status`, `get_download_history`, `cancel_download`, `remove_from_queue`, `clear_queue`, `remove_history_row`, `clear_history`, `get_video_comments`, `update_video`, `delete_video`, `rate_video`, `refresh_thumbnail`, `redownload_thumbnail`, `upload_subtitle`, `upload_video`, `upload_videos_batch`, `create_collection`, `update_collection`, `delete_collection`, `list_subscriptions`, `create_subscription`, `update_subscription`, `delete_subscription`, `pause_subscription`, `resume_subscription`, `create_playlist_subscription`, `subscribe_channel_playlists`, `list_tasks`, `cancel_task`, `delete_task`, `pause_task`, `resume_task`, `clear_finished_tasks`, `create_playlist_task`, `scan_files`, and `cleanup_temp_files`.

All admin tools are registered only in admin-session mode. Destructive tools are annotated as destructive, and `MCP_ALLOWED_TOOLS` can remove any tool from the advertised catalog.

## Resources and prompts

Resources use the `mytube://` scheme: library videos, individual videos, collections, active downloads, history, subscriptions, and system version. Prompts are `download-and-organize`, `audit-subscriptions`, `library-report`, and `find-and-download`; they are admin-session only because their workflows reference admin-only tools.
