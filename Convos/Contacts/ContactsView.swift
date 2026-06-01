import ConvosCore
import SwiftUI

struct ContactsView: View {
    @State private var viewModel: ContactsViewModel

    private let contactsRepository: any ContactsRepositoryProtocol
    private let contactsWriter: any ContactsWriterProtocol
    private let session: (any SessionManagerProtocol)?

    init(
        contactsRepository: any ContactsRepositoryProtocol,
        contactsWriter: any ContactsWriterProtocol = MockContactsWriter(),
        session: (any SessionManagerProtocol)? = nil
    ) {
        _viewModel = State(initialValue: ContactsViewModel(contactsRepository: contactsRepository))
        self.contactsRepository = contactsRepository
        self.contactsWriter = contactsWriter
        self.session = session
    }

    var body: some View {
        Group {
            if viewModel.contactCount == 0 {
                emptyState
            } else {
                contactsContent
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            Color.colorBackgroundRaisedSecondary
                .ignoresSafeArea()
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationTitle("Contacts")
    }

    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.2")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No contacts yet")
                .font(.title3)
                .fontWeight(.medium)
            Text("People you message will appear here")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var contactsContent: some View {
        let listSections: [ContactsListSection<ContactsViewModel.Row>] = viewModel.sections.map { section in
            ContactsListSection(id: section.id, title: section.title, rows: section.rows)
        }
        ContactsListView(sections: listSections) { row in
            NavigationLink {
                ContactDetailView(
                    contact: row.contact,
                    contactsWriter: contactsWriter,
                    contactsRepository: contactsRepository,
                    session: session,
                    showsCloseButton: false
                )
            } label: {
                ContactRowView(contact: row.contact, subtitle: row.subtitle)
            }
        } listBackground: {
            Color.colorBackgroundRaisedSecondary
        }
    }
}
