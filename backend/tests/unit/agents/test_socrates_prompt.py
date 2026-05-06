from backend.src.agents.prompts import build_shared_runtime_contract
from backend.src.agents.socrates import build_socrates_system_prompt
from backend.src.agents.worker import build_worker_system_prompt


def test_shared_runtime_contract_describes_task_workspace_rules():
    contract = build_shared_runtime_contract()

    assert "`inputs/`: backend-managed user inputs and attachments. Read-only." in contract
    assert "`work/`: scratch code" in contract
    assert "`outputs/`: final user-facing deliverables only." in contract
    assert "`logs/`: backend/system logs. Read-only." in contract
    assert "Never create folders named `input`, `inputs`, `output`, `outputs`, `log`, `logs`, or `work` inside another task folder." in contract
    assert "SOCRATES_TASK_ROOT" in contract
    assert "SOCRATES_INPUTS_DIR" in contract
    assert "SOCRATES_WORK_DIR" in contract
    assert "SOCRATES_OUTPUTS_DIR" in contract
    assert "SOCRATES_LOGS_DIR" in contract
    assert "reserved_task_folder_misuse" in contract
    assert "reserved_task_folder_created" in contract


def test_socrates_prompt_is_supervisor_and_reviewer_focused():
    prompt = build_socrates_system_prompt()

    assert "You are Socrates." in prompt
    assert "Socrates supervises; the worker implements." in prompt
    assert "Delegate normal implementation to the worker" in prompt
    assert "`start_worker`" in prompt
    assert "`execute_command` is allowed for inspection, reproduction, and verification." in prompt
    assert "Do not use commands to author implementation files or generate final deliverables during ordinary flow." in prompt
    assert "Task Lifecycle Doctrine" in prompt
    assert "one-word change" in prompt
    assert "The plan MUST be approved" in prompt
    assert "plan_approval_required" in prompt
    assert "todo_required" in prompt
    assert "acceptance_required" in prompt
    assert "todo_incomplete" in prompt
    assert "the task is not completed yet" in prompt
    assert "SOCRATES_OUTPUTS_DIR" in prompt
    assert "If the user asks what an uploaded image shows" in prompt
    assert 'refers generally to "the image", "the PDF", "the file", or "the project resource"' in prompt
    assert 'use `list_files(scope="project")` first' in prompt
    assert 'call `read_file(scope="project", path="...")` on the image itself before answering' in prompt
    assert "Never claim that no project image, PDF, file, or project resource exists unless you verified that with project tools." in prompt
    assert "update_current_todo_item(status=\"in_progress\")" not in prompt
    assert "Use the `next_item` returned by todo tools" not in prompt


def test_worker_prompt_is_socrates_branded_and_execution_focused():
    prompt = build_worker_system_prompt()

    assert "You are Socrates Worker." in prompt
    assert "PremChat Worker" not in prompt
    assert "You do not speak to the user." in prompt
    assert "Socrates is the planner, reviewer, and final communicator." in prompt
    assert "update_current_todo_item(status=\"in_progress\")" in prompt
    assert "Mark an item completed only with concrete evidence" in prompt
    assert "Block with a concrete reason and `recommended_action`" in prompt
    assert "Skip an item only when prior completed work genuinely made it unnecessary" in prompt
    assert "Never create folders named `input`, `inputs`, `output`, `outputs`, `log`, `logs`, or `work` inside another task folder." in prompt
    assert "SOCRATES_OUTPUTS_DIR" in prompt
    assert "SOCRATES_WORK_DIR" in prompt
    assert "SOCRATES_INPUTS_DIR" in prompt
    assert "Treat handoff workspace metadata as authoritative" in prompt
    assert "Return the structured worker result only" in prompt


def test_shared_contract_is_rendered_into_both_agent_prompts():
    socrates = build_socrates_system_prompt()
    worker = build_worker_system_prompt()

    for expected in [
        "`inputs/`",
        "`work/`",
        "`outputs/`",
        "`logs/`",
        "SOCRATES_OUTPUTS_DIR",
        "reserved_task_folder_created",
    ]:
        assert expected in socrates
        assert expected in worker
